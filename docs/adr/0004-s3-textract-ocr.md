# ADR 0004: S3 storage and hybrid Textract OCR with tracked asynchronous completion

- Status: Accepted
- Date: 2026-11-23

## Context

Milestone 2 replaces the in-memory file storage and stub OCR with Amazon S3 and Amazon Textract. Textract has two text-detection APIs:

- Synchronous `DetectDocumentText`: JPEG, PNG and single-page PDF, up to 10 MB, returns in seconds.
- Asynchronous `StartDocumentTextDetection` / `GetDocumentTextDetection`: multi-page PDF, up to 500 MB / 3,000 pages, takes seconds to minutes.

The Milestone 1 extraction port, `extract(): Promise<ExtractionResult>`, can only express a synchronous result. PDF processing must not hold an HTTP request open.

## Decision

### Hybrid OCR behind a two-phase port

- `TextExtractor.start()` returns either `COMPLETED` with the result or `IN_PROGRESS` with a job ID. `TextExtractor.check()` reports the state of a started job.
- The Textract adapter uses the synchronous API for PNG/JPEG and the asynchronous API for **all** PDFs, because the page count is not known without parsing the PDF.
- The application layer handles both outcomes the same way, so the sync/async split exists only inside the adapter.
- A fully asynchronous design was rejected. It would add latency, extra API calls and a 202 response for images in exchange for removing one adapter branch.

### Lifecycle

`PROCESSING → EXTRACTING` when a job starts. `EXTRACTING → PROCESSING` when it finishes, followed by artifact persistence and classification, then `PROCESSED`. `EXTRACTING → FAILED` on job failure, `PARTIAL_SUCCESS`, a permanent error or timeout.

Clients may start processing only from `STORED` or `FAILED`. Any other status returns 409.

### API

- `POST /process` returns 202 with status `EXTRACTING` and a `Location` header when a job was started, and 200 with `PROCESSED` otherwise, which is unchanged for images.
- The response adds the `EXTRACTING` status value and a `processingAttempts` field. These are additive changes.

### Completion trigger

- `CompleteExtractionService` performs one status check per call and owns the timeout and backoff policy.
- In Milestone 2 it is called by `InProcessCompletionScheduler`, behind the `CompletionScheduler` port. The scheduler keeps one timer per pending document; it never scans and never loops unboundedly.
- Bounds:
  - Exponential backoff between checks, capped at `TEXTRACT_POLL_MAX_DELAY_MS`.
  - A per-job deadline, `TEXTRACT_JOB_TIMEOUT_MS`.
  - A cap on tracked jobs, `TEXTRACT_MAX_PENDING_JOBS`. Beyond it, `/process` returns 503 before any job is submitted.
- Timers are `unref`'d and cleared on shutdown.
- In Milestone 4, a Textract SNS notification delivered through SQS calls the same service, and the scheduler is retired. `JobTag` carries the document ID so a notification can be mapped back to its document.

### Duplicate prevention

1. A status guard returns 409 unless the document is `STORED` or `FAILED`.
2. Optimistic concurrency: every record has a `version`, and the repository rejects stale writes. Two concurrent `/process` calls cannot both reach Textract. The same rule maps to `UPDATE … WHERE version = ?` in PostgreSQL.
3. `ClientRequestToken = {documentId}-{attempt}` makes a repeated start of the same attempt return the existing Textract job. A retry uses a new attempt number.
4. The scheduler keeps at most one timer per document.

### Extraction artifact

After OCR, a versioned (`schemaVersion: 1`), Zod-validated, provider-neutral JSON is written to `documents/{id}/extraction.json`. It holds:

- document ID and attempt
- engine and version
- timestamps
- per-page summaries
- lines with confidence (0–1, or `null` when missing)
- text
- warnings

Raw Textract responses are not persisted.

### `PARTIAL_SUCCESS`

Treated as failed, with the reason "Text extraction only partially succeeded". Missing pages would make invoice totals unreliable.

### Retries and errors

- AWS SDK standard retry mode, bounded by `AWS_MAX_ATTEMPTS`, plus per-attempt connection and request timeouts. There is no application-level retry around SDK calls.
- AWS errors are classified as retryable or permanent and converted to sanitised `ExternalServiceError`s. The original AWS error, which may name buckets or keys, is not attached; only the error name, HTTP status and request ID are kept.
- Status reasons visible through the API come only from our own fixed messages.

### Storage

`PutObject` is sent with:

- the canonical `ContentType`
- `ChecksumSHA256`, so S3 verifies integrity
- `IfNoneMatch: '*'`, so an upload never overwrites an existing object (the artifact explicitly opts into overwrite)
- metadata `document-id`
- optional SSE-KMS

Delete is deferred.

## Consequences

- Images behave as before. PDFs complete in the background without long-running requests.
- Metadata and job tracking remain in memory until PostgreSQL (Milestone 5). A restart loses records and abandons in-flight jobs, leaving S3 objects orphaned. The in-process scheduler is single-instance only. Both are documented as limitations.
- `AnalyzeExpense` (structured invoice fields) is deferred. The port allows it to be swapped in later.

## Amendments after engineering review (2026-11-23)

- **Network errors:** classified by an explicit, tested allowlist of Node error codes, plus the SDK `$retryable` marker, `TimeoutError` and S3 `ConditionalRequestConflict`.
  - Allowlisted codes: `ECONNRESET`, `ECONNREFUSED`, `ECONNABORTED`, `ETIMEDOUT`, `EPIPE`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, `ENETDOWN`, and undici socket/connect timeouts.
  - Unknown codes and status-less errors are not assumed transient.
- **Capacity reservation:** the `CompletionScheduler` port replaces `hasCapacity()` with a synchronous `reserve()` that returns a releasable reservation.
  - `TextExtractor.isAsynchronous(fileType)` decides, without side effects, whether a slot is needed. Only PDFs reserve.
  - The reservation is taken before the first await and consumed by `schedule()`. Otherwise it is released in a `finally` block.
- **Ambiguous S3 success:** a `412` on a non-overwrite `PutObject` triggers `HeadObject` with `ChecksumMode=ENABLED`. The write is accepted only when both the `document-id` metadata and the SHA-256 match.
- **Untrackable jobs:** if a job is submitted but the `EXTRACTING` record cannot be saved, the job ID is logged at warn level and kept on the `FAILED` record. Automatic recovery is deferred to persistent job tracking (Milestones 4/5).
- **Synchronous image limit:** with the Textract adapter, PNG/JPEG over 10,000,000 bytes are rejected at upload with 413. Textract documents the synchronous limit as 10 MB; the decimal interpretation is used because it is the conservative one.
- **Shutdown:** `close()` is asynchronous. It cancels timers, waits for in-flight checks (5 s deadline), logs abandoned jobs, and only then destroys the AWS clients.
- **Failure recording:** never throws. A failure to persist `FAILED` is logged as a stuck document, and the original error is still the one reported.
- **Processing eligibility:**
  - `FAILED → PROCESSING` requires that the document once reached `STORED`.
  - Deterministic failures are recorded as `lastFailure.code` and block retries, because each retry would be a new billable job with the same outcome: `RESULT_LIMIT_EXCEEDED`, `DOCUMENT_TOO_LARGE`, `UNSUPPORTED_DOCUMENT`, `BAD_DOCUMENT`.
- **Production guard:** `NODE_ENV=production` with `EXTRACTOR_DRIVER=textract` is rejected at startup. There is no override flag until authentication exists (Milestone 5).
