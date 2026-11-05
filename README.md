# AI Document Intelligence

A backend service for ingesting invoice documents (PDF, PNG, JPEG), tracking their processing lifecycle, and, in later milestones, extracting and classifying invoice data with AWS Textract and Amazon Bedrock.

> **Status: Milestone 1 (Foundation).** Storage, extraction and classification currently use **local in-memory/stub adapters**. **No AWS service is integrated yet.**

## Current limitations (Milestone 1)

- **Data is not persisted.** Documents and status records are held in process memory and are **lost when the server restarts**. This is expected at this stage and is not a production persistence solution. PostgreSQL (metadata) and S3 (files) replace the in-memory adapters in Milestones 2 and 5 without changes to the business logic.
- **Processing is synchronous.** `POST /v1/documents/:id/process` runs extraction and classification within the HTTP request. Asynchronous, SQS-based processing with retries, idempotency and a dead-letter queue is planned for Milestone 4.
- **Extraction and classification are placeholders.** The stub extractor returns no text, and the keyword classifier is deterministic. Textract (M2) and Bedrock (M3) will replace them.
- **Single instance only.** In-memory state is not shared between processes.
- **No authentication or rate limiting yet** (Milestone 5). Do not expose the service publicly.

## Known dependency advisories

`npm audit` reports moderate advisories in `minimatch`. They reach the project only through the ESLint / typescript-eslint **development** toolchain and are not part of the runtime dependency tree (`npm audit --omit=dev` is clean). They are not force-fixed, because `npm audit fix --force` would make breaking downgrades. They will be picked up through normal upstream releases.

## Stack

Node.js 22+, TypeScript (strict), Fastify 5, Zod 4, Vitest, ESLint (typescript-eslint strict type-checked), Prettier.

## Architecture

```
api/            HTTP: routes, request/response schemas, RFC 9457 error mapping, OpenAPI
   │  calls
application/    use cases (Ingest, Get, Process) + ports (interfaces)
   │  uses
domain/         document state machine, upload policy, file signatures, invoice model
infrastructure/ adapters implementing ports (Milestone 1: in-memory / stub)
container.ts    composition root: picks adapters and wires services (manual DI)
```

The dependency rule: `domain` imports nothing; `application` imports only `domain` and its own ports; `infrastructure` implements ports; `api` talks only to application services.

| Port                 | Milestone 1 adapter          | Planned adapter |
| -------------------- | ---------------------------- | --------------- |
| `DocumentRepository` | `InMemoryDocumentRepository` | PostgreSQL (M5) |
| `DocumentStorage`    | `InMemoryDocumentStorage`    | S3 (M2)         |
| `TextExtractor`      | `StubTextExtractor`          | Textract (M2)   |
| `DocumentClassifier` | `KeywordDocumentClassifier`  | Bedrock (M3)    |

See [docs/adr](docs/adr) for the reasoning behind these decisions.

### Document lifecycle

```
RECEIVED ─► STORED ─► PROCESSING ─► PROCESSED
    │          │           │
    └──────────┴───────────┴──► FAILED ──(retry)──► PROCESSING
```

Every transition is appended to `statusHistory` with a timestamp and an optional reason, so the history can be audited.

## Getting started

```bash
nvm use            # Node 22
npm ci
cp .env.example .env   # optional; all settings have safe defaults
npm run dev
```

OpenAPI UI: http://localhost:3000/docs (disable with `API_DOCS_ENABLED=false`).

### Configuration

Validated with Zod at startup; invalid values stop the process with a clear message.

| Variable             | Default      | Notes                           |
| -------------------- | ------------ | ------------------------------- |
| `NODE_ENV`           | development  | development / test / production |
| `HOST` / `PORT`      | 0.0.0.0/3000 |                                 |
| `LOG_LEVEL`          | info         | pino levels, or `silent`        |
| `MAX_UPLOAD_BYTES`   | 10485760     | Hard cap of 50 MiB              |
| `REQUEST_TIMEOUT_MS` | 30000        |                                 |
| `API_DOCS_ENABLED`   | true         | Serve `/docs`                   |

## API

| Method | Path                        | Description                                          |
| ------ | --------------------------- | ---------------------------------------------------- |
| GET    | `/health`                   | Liveness                                             |
| POST   | `/v1/documents`             | Multipart upload, one file in the `file` field → 201 |
| GET    | `/v1/documents/:id`         | Document metadata and status history                 |
| POST   | `/v1/documents/:id/process` | Run extraction + classification (synchronous in M1)  |

```bash
curl -F "file=@sample.pdf;type=application/pdf" http://localhost:3000/v1/documents
```

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

| Status | Code(s)                                           |
| ------ | ------------------------------------------------- |
| 400    | `VALIDATION_ERROR`, `EMPTY_FILE`                  |
| 404    | `DOCUMENT_NOT_FOUND`, `ROUTE_NOT_FOUND`           |
| 409    | `INVALID_STATUS_TRANSITION`                       |
| 413    | `FILE_TOO_LARGE`                                  |
| 415    | `UNSUPPORTED_FILE_TYPE`, `UNSUPPORTED_MEDIA_TYPE` |
| 502    | `EXTERNAL_SERVICE_ERROR`                          |

## Upload security

- Allow-list of extensions **and** declared MIME types **and** magic-byte signatures, which must all agree on one type. This catches a renamed executable, a spoofed `Content-Type` and polyglot files that prefix a PDF.
- Size limit enforced while streaming, so an oversized upload is never fully buffered. Exactly one file per request.
- Original filenames are sanitised (path components, control and bidi characters stripped) and used only as metadata. Storage keys are derived from the server-generated UUID.
- A SHA-256 checksum is recorded for integrity checks and future deduplication.
- Correlation IDs from `x-request-id` are accepted only if they match `[A-Za-z0-9._-]{1,128}`, which prevents log injection. Auth headers are redacted from logs.
- 5xx responses never expose internal error details.

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

All test fixtures are synthetic byte sequences; no real invoices or customer data are used.

## Roadmap

1. **Foundation** (this milestone): ingestion, validation, lifecycle, invoice schema, ports
2. S3 storage and Textract extraction
3. Bedrock classification with versioned prompts and validated structured output
4. SQS asynchronous processing, idempotency, DLQ
5. PostgreSQL, auth, rate limiting, Docker, CI/CD
