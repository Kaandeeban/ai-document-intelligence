# ADR 0002: Defence-in-depth upload validation

- Status: Accepted
- Date: 2026-11-04

## Context

Uploaded documents are untrusted. A client controls the filename and the declared `Content-Type`, so neither can be trusted on its own.

## Decision

An upload is accepted only if **all** of the following hold:

1. It is not empty and is no larger than `MAX_UPLOAD_BYTES`. The size limit is enforced while streaming by `@fastify/multipart`, and checked again in the domain.
2. Its extension is on the allow-list (`.pdf`, `.png`, `.jpg`, `.jpeg`).
3. Its declared MIME type is on the allow-list (`application/pdf`, `image/png`, `image/jpeg`).
4. Its magic bytes identify a supported type. PDF must start at offset 0, which is stricter than the PDF specification and rejects prefixed polyglot files.
5. All three of extension, MIME type and signature map to **the same** type.

Additional rules:

- Exactly one file is allowed per request.
- The stored MIME type is the canonical one for the detected type, not the client's string.
- The filename is sanitised and kept only as display metadata. Storage keys are `documents/{uuid}/original.{ext}`.

## Consequences

- Error codes are explicit: `EMPTY_FILE` (400), `FILE_TOO_LARGE` (413) and `UNSUPPORTED_FILE_TYPE` (415).
- Signature checks don't prove a file is well-formed or harmless. Deeper inspection (PDF structure and active content, image decoding limits, malware scanning) is planned before production.
- Whole files are buffered in memory up to the limit. That is acceptable for 10 MiB invoices; Milestone 2 can stream directly to S3 if the limits grow.
