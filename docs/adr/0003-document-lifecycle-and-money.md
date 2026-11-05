# ADR 0003: Explicit document lifecycle and integer money

- Status: Accepted
- Date: 2026-11-04

## Context

Processing is multi-stage and can fail partway through. Operators need to know where each document is and how it got there. Invoice totals must be checked for consistency without floating-point errors.

## Decision

- **Lifecycle:** `RECEIVED → STORED → PROCESSING → PROCESSED`. `FAILED` is reachable from any non-terminal state, and `FAILED → PROCESSING` allows a retry. `PROCESSED` is terminal; safe reprocessing comes with idempotency in Milestone 4.
  - Transitions are pure functions that return a new record. Illegal transitions throw `InvalidStatusTransitionError`, which the API returns as 409.
  - Every transition appends `{status, at, reason?}` to `statusHistory`, giving an audit trail.
  - The record is persisted **before** each side effect, so a crash leaves an accurate status.
- **Money:** amounts are integers in minor units (`subtotalMinor`, `totalMinor`, …), and the currency is an ISO 4217 code.
- **Invoice validation** has two layers:
  - The Zod schema checks structure.
  - `validateInvoice()` checks business rules and returns a list of issues instead of throwing: line sums, subtotal plus tax equals total, due date on or after issue date, and low-confidence fields. Extracted data and its validation report can then be returned together.

## Consequences

- Converting between minor units and decimal amounts is the responsibility of the extraction mapping layer (Milestone 2). Currencies with three decimal places are handled by the currency's exponent at that layer.
- The in-memory repository has no optimistic locking; concurrent processing of the same document is addressed in Milestone 4.
