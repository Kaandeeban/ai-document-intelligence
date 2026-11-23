# AI Document Intelligence

A backend service for ingesting invoice documents (PDF, PNG, JPEG), storing them, running OCR, and tracking their processing lifecycle. Amazon Bedrock classification comes in a later milestone.

> **Status: Milestone 2 (S3 + Textract).** S3 storage and Textract OCR adapters are implemented and covered by **mocked** tests only. They have **not been run against a real AWS account**. The default configuration runs entirely locally with in-memory and stub adapters.

## Current limitations

- **Metadata and job tracking are in memory.** Document records, status history and in-flight Textract job tracking are **lost when the server restarts**. This is not a production persistence solution; PostgreSQL arrives in Milestone 5. With `STORAGE_DRIVER=s3`, files and extraction artifacts survive a restart but their records do not. **Restart-recovery risks:**
  - PDF jobs that are `EXTRACTING` when the process stops are abandoned. Textract still processes them (and bills for them), but nothing collects the result.
  - Their S3 objects become orphans with no record. A bucket lifecycle rule is recommended.
  - Uploading again creates a new document and a new job; there is no deduplication yet.
  - Graceful shutdown waits up to 5 s for in-flight status checks, then logs how many jobs are abandoned.
  - If a job is submitted but its `EXTRACTING` record cannot be saved, the job ID is logged at warn level and kept on the `FAILED` record. **Nothing collects that job automatically**; durable recovery needs persistent job tracking (Milestones 4/5).
- **Single instance only.** Completion checks run on in-process timers, and optimistic concurrency is enforced only within one process. Do not run more than one instance until Milestone 4 (SNS/SQS completion, idempotency) and Milestone 5 (PostgreSQL).
- **OCR text only.** Textract `DetectDocumentText` produces lines, pages and confidence. Invoice fields (supplier, totals, line items) are not extracted yet. Bedrock normalisation comes in M3; `AnalyzeExpense` is deferred to a future architecture review.
- **Classification is a placeholder** keyword classifier until Bedrock (M3).
- **No authentication or rate limiting** (M5). With `EXTRACTOR_DRIVER=textract`, **anyone who can reach the API can trigger billable OCR.**
  - **Production fails closed:** `NODE_ENV=production` together with `EXTRACTOR_DRIVER=textract` is rejected at startup. There is deliberately no override until authentication exists.
  - In development, do not expose the service publicly.
- **AWS integration is unverified against real AWS.** All AWS behaviour is tested with SDK mocks (see [Testing](#testing)).

## Known dependency advisories

`npm audit` reports moderate advisories in `minimatch`. They reach the project only through the ESLint / typescript-eslint **development** toolchain and are not part of the runtime dependency tree (`npm audit --omit=dev` is clean). They are not force-fixed, because `npm audit fix --force` would make breaking downgrades. They will be picked up through normal upstream releases.

## Stack

Node.js 22+, TypeScript (strict), Fastify 5, Zod 4, AWS SDK for JavaScript v3 (`@aws-sdk/client-s3`, `@aws-sdk/client-textract`), Vitest, `aws-sdk-client-mock`, ESLint (typescript-eslint strict type-checked), Prettier.

## Architecture

```
api/            HTTP: routes, request/response schemas, RFC 9457 error mapping, OpenAPI
   │  calls
application/    use cases (Ingest, Get, Process, CompleteExtraction) + ports (interfaces)
   │  uses
domain/         state machine, upload policy, file signatures, OCR contracts, extraction artifact, invoice model
infrastructure/ adapters: in-memory/stub (local), aws/ (S3, Textract), in-process completion scheduler
container.ts    composition root: selects adapters from config, creates AWS clients, wires services
```

The dependency rule: `domain` imports nothing; `application` imports only `domain` and its own ports; `infrastructure` implements ports. **The AWS SDK is imported only in `src/infrastructure/aws/`.**

| Port                  | Local adapter (default)        | AWS adapter             | Later                 |
| --------------------- | ------------------------------ | ----------------------- | --------------------- |
| `DocumentRepository`  | `InMemoryDocumentRepository`   | —                       | PostgreSQL (M5)       |
| `DocumentStorage`     | `InMemoryDocumentStorage`      | `S3DocumentStorage`     |                       |
| `TextExtractor`       | `StubTextExtractor`            | `TextractTextExtractor` |                       |
| `CompletionScheduler` | `InProcessCompletionScheduler` | (same)                  | SNS → SQS worker (M4) |
| `DocumentClassifier`  | `KeywordDocumentClassifier`    | —                       | Bedrock (M3)          |

See [docs/adr](docs/adr) for the reasoning; [ADR 0004](docs/adr/0004-s3-textract-ocr.md) covers this milestone.

### Document lifecycle

```
RECEIVED ─► STORED ─► PROCESSING ─────(OCR finished immediately: images)───────► PROCESSED
                          │
                          └─(job started: PDF)─► EXTRACTING ─(job done)─► PROCESSING ─► PROCESSED
Any non-terminal state ──► FAILED ──(retry: POST /process)──► PROCESSING
```

- Clients may call `POST /process` when a document is `STORED`, or `FAILED` as a retry. Otherwise the response is **409**. A `FAILED` document can be retried only if:
  - it reached `STORED` at some point. An upload that failed before storage has nothing to process.
  - its last failure is not **deterministic**. Deterministic failures recur on every attempt and every attempt would be billed, so they are not retried:
    - result exceeds `TEXTRACT_MAX_RESULT_PAGES`
    - `DocumentTooLargeException`
    - `UnsupportedDocumentException`
    - `BadDocumentException`
- Every transition is appended to `statusHistory` with a timestamp and, for failures, a sanitised reason.
- Every change increments a `version` used for optimistic concurrency.

### OCR: hybrid synchronous/asynchronous

`TextExtractor` is two-phase: `start()` either finishes (`COMPLETED`) or starts a job (`IN_PROGRESS`); `check()` reports a job's state. The application handles both outcomes uniformly.

| Input     | Textract API                                                      | API response                             |
| --------- | ----------------------------------------------------------------- | ---------------------------------------- |
| PNG, JPEG | `DetectDocumentText` (synchronous)                                | **200** `PROCESSED`                      |
| PDF       | `StartDocumentTextDetection` → `GetDocumentTextDetection` (async) | **202** `EXTRACTING` + `Location` header |

All PDFs use the asynchronous API (which supports multi-page documents), because the page count is unknown before OCR. Textract reads documents **directly from S3**; the service never downloads them again.

### Asynchronous completion (no long-running HTTP request)

1. `POST /process` starts the Textract job, records `{jobId, startedAt}` on the document (never exposed in the API), moves it to `EXTRACTING`, schedules a check and returns **202** immediately.
2. `InProcessCompletionScheduler` holds **one timer per pending document**. It never scans the repository and never loops while nothing is pending. Timers are `unref`'d. On shutdown, pending timers are cancelled and the scheduler waits (up to 5 s) for in-flight checks **before** the AWS clients are destroyed.
3. Each timer calls `CompleteExtractionService`, which performs **one** `GetDocumentTextDetection` check:
   - Still running: check again later, with exponential backoff (`TEXTRACT_POLL_INITIAL_DELAY_MS` doubling up to `TEXTRACT_POLL_MAX_DELAY_MS`), never past the deadline.
   - `SUCCEEDED`: write the extraction artifact, classify, and move to `PROCESSED`.
   - `FAILED` or `PARTIAL_SUCCESS`: move to `FAILED` with a sanitised reason.
   - Still running at `TEXTRACT_JOB_TIMEOUT_MS`: move to `FAILED` ("Text extraction timed out"). This is retryable.
4. **Capacity:** at most `TEXTRACT_MAX_PENDING_JOBS` asynchronous jobs are tracked.
   - For a PDF, `/process` reserves a slot **synchronously, before any await**, so concurrent requests cannot oversubscribe. The reservation happens before the document is saved and before anything is submitted to Textract.
   - With no slot free, the response is **503** with `Retry-After` and the document stays `STORED`.
   - The slot is released on every failure path, and when the job finishes.
   - Images never take or wait for a slot.
5. Clients poll `GET /v1/documents/:id` until the status is `PROCESSED` or `FAILED`.

**Milestone 4:** Textract's SNS completion notification is delivered through SQS, and a worker calls the same `CompleteExtractionService`. `JobTag` already carries the document ID for that mapping.

### Duplicate-submission prevention

- **Status guard:** a second `/process` while `PROCESSING`, `EXTRACTING` or `PROCESSED` returns 409.
- **Optimistic concurrency:** two concurrent `/process` calls cannot both claim a document; the loser gets 409 before any Textract call.
- **Textract idempotency:** `ClientRequestToken = {documentId}-{attempt}`, so re-submitting the same attempt returns the existing job instead of starting a new billable one. Retries use a new attempt number.
- **One timer per document** in the scheduler.

### Storage layout and extraction artifact

| Object                                    | Written by                                     |
| ----------------------------------------- | ---------------------------------------------- |
| `documents/{uuid}/original.{pdf,png,jpg}` | upload (never overwritten: `IfNoneMatch: '*'`) |
| `documents/{uuid}/extraction.json`        | OCR completion (replaced on retry)             |

**Ambiguous upload results:** S3 can return `412 PreconditionFailed` because an SDK retry hit our own earlier write, which succeeded but whose response was lost. In that case the adapter calls `HeadObject` (with checksum mode) and accepts the write **only if** both:

- the `document-id` metadata matches; and
- the stored SHA-256 matches.

Any mismatch, missing value or `HeadObject` error remains a failure. `HeadObject` needs no IAM permission beyond `s3:GetObject`.

Keys come only from the server-generated UUID. Original filenames are metadata and never reach S3. Bucket names and keys never appear in API responses.

`extraction.json` (schema version 1, Zod-validated) contains:

- document ID and attempt
- OCR engine and version
- start and completion timestamps
- page count and per-page line count and confidence
- text lines with page and confidence (0–1, or `null` when Textract gave none)
- the full text
- warnings: `NO_TEXT_DETECTED`, `MISSING_CONFIDENCE`, `LOW_CONFIDENCE`

Raw Textract responses are not stored. The artifact is not exposed through the API in this milestone.

### Errors, timeouts and retries

- **Per AWS attempt:** connection and request timeouts (`AWS_CONNECTION_TIMEOUT_MS`, `AWS_REQUEST_TIMEOUT_MS`).
- **SDK retries:** standard retry mode with exponential backoff and jitter for throttling, 5xx and network errors, bounded by `AWS_MAX_ATTEMPTS`. There is no application-level retry around SDK calls, so retries never multiply.
- **Error classification:** AWS errors are classified as retryable or permanent.
  - Retryable:
    - AWS errors such as `ThrottlingException`, `ProvisionedThroughputExceededException`, `LimitExceededException`, `SlowDown`, `ConditionalRequestConflict` and `TimeoutError`
    - errors the SDK marks `$retryable`
    - any 5xx
    - an **explicit allowlist** of Node network error codes: `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, `ENETDOWN`, `UND_ERR_SOCKET`, `UND_ERR_CONNECT_TIMEOUT`

    Other codes (e.g. `ENOTFOUND`, usually a misconfigured region or endpoint) and errors without status or code are **not** assumed transient.

  - Permanent: `AccessDenied*`, `ExpiredToken`, `InvalidS3ObjectException`, `UnsupportedDocumentException`, `BadDocumentException`, `DocumentTooLargeException`, `InvalidJobIdException`, `PreconditionFailed` (after the verification above).
  - A retryable error while checking a job leads to another check before the deadline. A permanent one moves the document straight to `FAILED`.
- **Shutdown:** see step 2 above. Checks still running at the deadline are abandoned and logged.
- **What is logged:** AWS errors are reduced to a sanitised error with only the AWS error name, HTTP status and request ID. The original AWS message (which can contain bucket or key names) is not logged. Extracted text, Textract blocks and file contents are never logged.
- **What the API shows:** status reasons come from a fixed set of messages, e.g. "Text extraction job failed".

## Getting started (local, no AWS)

```bash
nvm use            # Node 22
npm ci
cp .env.example .env   # optional; defaults are local-only
npm run dev
```

OpenAPI UI: http://localhost:3000/docs (disable with `API_DOCS_ENABLED=false`).

## Configuration

Validated with Zod at startup; invalid or inconsistent values stop the process with a clear message.

| Variable                         | Default      | Notes                                                                                                                                              |
| -------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                       | development  | development / test / production                                                                                                                    |
| `HOST` / `PORT`                  | 0.0.0.0/3000 |                                                                                                                                                    |
| `LOG_LEVEL`                      | info         | pino levels, or `silent`                                                                                                                           |
| `MAX_UPLOAD_BYTES`               | 10485760     | Hard cap 50 MiB. With `EXTRACTOR_DRIVER=textract`, PNG/JPEG are also limited to 10,000,000 bytes (Textract synchronous 10 MB limit, decimal) → 413 |
| `REQUEST_TIMEOUT_MS`             | 30000        |                                                                                                                                                    |
| `API_DOCS_ENABLED`               | true         | Serve `/docs`                                                                                                                                      |
| `STORAGE_DRIVER`                 | `memory`     | `memory` \| `s3`                                                                                                                                   |
| `EXTRACTOR_DRIVER`               | `stub`       | `stub` \| `textract`. **`textract` requires `s3`**                                                                                                 |
| `AWS_REGION`                     | —            | Required when any AWS adapter is enabled. Must match the bucket's region                                                                           |
| `AWS_S3_BUCKET`                  | —            | Required for `s3`                                                                                                                                  |
| `AWS_S3_KMS_KEY_ID`              | —            | Optional SSE-KMS key; otherwise bucket default encryption                                                                                          |
| `AWS_MAX_ATTEMPTS`               | 3            | SDK attempts per call (1–10)                                                                                                                       |
| `AWS_CONNECTION_TIMEOUT_MS`      | 3000         | Per attempt                                                                                                                                        |
| `AWS_REQUEST_TIMEOUT_MS`         | 10000        | Per attempt                                                                                                                                        |
| `TEXTRACT_POLL_INITIAL_DELAY_MS` | 2000         | First status check; doubles per check                                                                                                              |
| `TEXTRACT_POLL_MAX_DELAY_MS`     | 15000        | Backoff cap                                                                                                                                        |
| `TEXTRACT_JOB_TIMEOUT_MS`        | 300000       | Then `FAILED` (retryable)                                                                                                                          |
| `TEXTRACT_MAX_RESULT_PAGES`      | 100          | Result pages fetched per job (memory bound)                                                                                                        |
| `TEXTRACT_MAX_PENDING_JOBS`      | 50           | Tracked async jobs; beyond it `/process` returns 503                                                                                               |

### Selecting adapters

| Mode            | Settings                                           |
| --------------- | -------------------------------------------------- |
| Local (default) | nothing; `memory` + `stub`                         |
| S3 storage only | `STORAGE_DRIVER=s3`, `AWS_REGION`, `AWS_S3_BUCKET` |
| S3 + Textract   | add `EXTRACTOR_DRIVER=textract`                    |

The selected adapters are logged at startup. AWS clients are created only when an AWS adapter is selected.

### AWS credentials

The service **never reads credentials from its own configuration**. The AWS SDK's default provider chain is used:

- Locally: `AWS_PROFILE` or SSO.
- Deployed: an IAM role (ECS task role, Lambda execution role or EC2 instance profile).

Never put access keys in `.env` files committed to Git.

## AWS setup (manual; not automated by this project)

No AWS resources are created by this repository. To try the AWS adapters you need to create:

1. **An S3 bucket in the same region as `AWS_REGION`**, with:
   - Block Public Access enabled
   - default encryption (SSE-S3 or SSE-KMS)
   - a bucket policy denying non-TLS requests (`aws:SecureTransport = false`)
   - versioning
   - a lifecycle rule to expire orphaned objects under `documents/`
2. **IAM permissions** for the service's role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "DocumentObjects",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::<bucket>/documents/*"
    },
    {
      "Sid": "TextractTextDetection",
      "Effect": "Allow",
      "Action": [
        "textract:DetectDocumentText",
        "textract:StartDocumentTextDetection",
        "textract:GetDocumentTextDetection"
      ],
      "Resource": "*"
    }
  ]
}
```

- Textract reads the S3 object **with the caller's credentials**, so `s3:GetObject` is also required for OCR. The same permission covers `HeadObject` (upload verification).
- `s3:ListBucket` is intentionally not granted. Without it, S3 returns `AccessDenied` (403) rather than `NoSuchKey` for a missing object. This only matters for direct reads, which the Textract path does not perform.
- With `AWS_S3_KMS_KEY_ID`, also grant `kms:GenerateDataKey` and `kms:Decrypt` on that key.
- No SNS or SQS permissions are needed until Milestone 4.

3. **Data governance:** AWS may use content processed by Textract to improve its services unless your AWS Organization has an **AI services opt-out policy**. Review this before processing real invoices.
4. **Cost:** Textract bills per page processed. `ClientRequestToken` prevents duplicate jobs per attempt, but every retry is a new billable job.

## API

| Method | Path                        | Description                                                                          |
| ------ | --------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/health`                   | Liveness                                                                             |
| POST   | `/v1/documents`             | Multipart upload, one file in the `file` field → 201                                 |
| GET    | `/v1/documents/:id`         | Document metadata, `status`, `processingAttempts` and status history                 |
| POST   | `/v1/documents/:id/process` | Start OCR + classification → **200** `PROCESSED` or **202** `EXTRACTING` (async PDF) |

```bash
curl -F "file=@sample.pdf;type=application/pdf" http://localhost:3000/v1/documents
curl -X POST http://localhost:3000/v1/documents/<id>/process     # 202 for PDFs with Textract
curl http://localhost:3000/v1/documents/<id>                     # poll until PROCESSED / FAILED
```

**Compatibility with Milestone 1:**

- Existing fields and responses are unchanged.
- Added: the `EXTRACTING` status value, the `processingAttempts` field, the 202 response for asynchronous PDFs, and the 409 `CONCURRENT_MODIFICATION` and 503 `SERVICE_UNAVAILABLE` errors.
- In local mode (`stub`), `/process` still always returns 200.

Errors use `application/problem+json` and include a stable `code` and the `requestId`:

```json
{
  "type": "about:blank",
  "title": "Unsupported Media Type",
  "status": 415,
  "code": "UNSUPPORTED_FILE_TYPE",
  "detail": "File extension, content type and content do not match",
  "instance": "/v1/documents",
  "requestId": "…"
}
```

| Status | Code(s)                                                                                              |
| ------ | ---------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_ERROR`, `EMPTY_FILE`                                                                     |
| 404    | `DOCUMENT_NOT_FOUND`, `ROUTE_NOT_FOUND`                                                              |
| 409    | `INVALID_STATUS_TRANSITION` (incl. never-stored or deterministic failure), `CONCURRENT_MODIFICATION` |
| 413    | `FILE_TOO_LARGE` (global limit, or 10,000,000-byte image limit with Textract)                        |
| 415    | `UNSUPPORTED_FILE_TYPE`, `UNSUPPORTED_MEDIA_TYPE`                                                    |
| 502    | `EXTERNAL_SERVICE_ERROR`                                                                             |
| 503    | `SERVICE_UNAVAILABLE` (with `Retry-After`)                                                           |

## Security

- **Upload validation:** extension, declared MIME type and magic-byte signature must all agree on one type. This catches renamed executables, spoofed `Content-Type` headers and PDF polyglots.
- **Upload limits:** the size limit is enforced while streaming, and only one file is accepted per request. With Textract, images over 10,000,000 bytes are rejected at upload instead of failing OCR later.
- **Billable OCR:** refused in production until authentication exists (fail-closed config check, no override).
- **Filenames:** sanitised and kept only as metadata. Storage keys come only from server-generated UUIDs.
- **S3 writes:** an existing object is never overwritten, and a SHA-256 checksum is verified by S3.
- **No secrets in config:** no credentials in configuration, logs or the repository.
- **Logging:**
  - AWS error messages are reduced to an error name and request ID.
  - Extracted text and document contents are never logged.
  - `x-request-id` is validated to prevent log injection.
  - Authentication headers are redacted.
- **Error responses:** 5xx responses and status reasons never expose internal error details.

## Testing

```bash
npm test                    # all tests, no AWS access required
npm run test:unit
npm run test:integration
npm run test:coverage
```

- **AWS adapters** are tested with [`aws-sdk-client-mock`](https://github.com/m-radzikowski/aws-sdk-client-mock). Test clients use fake credentials, so no request can reach a real AWS account. Covered:
  - S3: request shapes, encryption, missing objects, error classification.
  - Textract: sync and async paths, multi-page results, `FAILED` / `PARTIAL_SUCCESS`, malformed responses, missing and low confidence, the result-page limit, throttling and permission errors.
- **SDK-level retries are not exercised by the mocks**, which replace the client's `send` and bypass the SDK's retry middleware. The tests check the configured `maxAttempts` and the retryable/permanent classification, not real retry timing.
- **Asynchronous completion** (backoff, deadline, timeout, failures, duplicate and concurrent submissions, capacity reservation under concurrency, shutdown waiting and deadline, stuck-state logging, untracked-job recording, deterministic-failure retry refusal) is tested with a fake clock and fake timers, and end-to-end over HTTP with a fake asynchronous OCR adapter.
- All fixtures are synthetic. No real invoices or customer data are used.

> **Windows note:** run tests from a path with an **uppercase** drive letter (`D:\…`). Vitest can fail with "failed to find the runner" when the working directory uses a lowercase drive letter (`d:\…`).

## Scripts

| Script                     | Purpose                          |
| -------------------------- | -------------------------------- |
| `npm run typecheck`        | `tsc --noEmit`                   |
| `npm run lint`             | ESLint                           |
| `npm run format:check`     | Prettier                         |
| `npm test`                 | All tests                        |
| `npm run test:unit`        | Unit tests                       |
| `npm run test:integration` | API tests via Fastify `inject()` |
| `npm run test:coverage`    | Coverage report                  |
| `npm run build`            | Compile to `dist/`               |
| `npm run check`            | typecheck + lint + test + build  |

## Roadmap

1. ~~Foundation: ingestion, validation, lifecycle, invoice schema, ports~~
2. **S3 storage and Textract OCR (this milestone)**: implemented with mocked tests
3. Bedrock classification and normalisation, with versioned prompts and validated structured output
4. SQS/SNS asynchronous orchestration, idempotency, DLQ (replaces the in-process scheduler)
5. PostgreSQL, auth, rate limiting, Docker, deployment
