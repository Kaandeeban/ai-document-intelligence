# ADR 0001: Layered architecture with ports and adapters

- Status: Accepted
- Date: 2026-11-04

## Context

The platform will integrate S3, Textract, Bedrock, SQS and PostgreSQL. Each of these is slow, billable, or both, and is hard to run in unit tests. The business rules (upload policy, lifecycle and invoice validation) should not change when an integration does.

## Decision

- Four layers: `domain` → `application` → `infrastructure` / `api`. The domain has no I/O and no framework imports.
- The application layer defines **ports** (`DocumentRepository`, `DocumentStorage`, `TextExtractor`, `DocumentClassifier`, `Clock`, `IdGenerator`, `Logger`). Services depend only on these interfaces.
- **Manual constructor injection**, wired in a single composition root (`src/container.ts`). No DI container library: the dependency graph is small, and explicit wiring is easier to read and type-check.
- `buildApp({ config, adapters })` accepts adapter overrides, so tests (and later the AWS wiring) can swap in any implementation.
- Application services **re-validate adapter responses with Zod** (`extractionResultSchema`, `classificationResultSchema`). A faulty adapter, or a malformed model output, becomes an `ExternalServiceError` and a `FAILED` status rather than corrupted state.

## Consequences

- Adding S3, Textract or Bedrock means writing a new adapter and changing the composition root. Services and domain code stay untouched.
- There is a small amount of extra code (interfaces, mapping) compared with calling the SDKs directly.
- Milestone 1 runs entirely offline.
