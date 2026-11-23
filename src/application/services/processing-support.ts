import type { z } from 'zod';
import {
  DETERMINISTIC_FAILURE_CODES,
  transitionDocument,
  type DeterministicFailureCode,
  type DocumentRecord,
  type ExtractionJob,
} from '../../domain/document.js';
import { DomainError, ExternalServiceError } from '../../domain/errors.js';
import type { Clock, DocumentRepository, Logger } from '../ports/index.js';

/** Sanitised, API-visible reasons for failures that will recur on every attempt. */
const DETERMINISTIC_FAILURE_MESSAGES: Readonly<Record<DeterministicFailureCode, string>> = {
  RESULT_LIMIT_EXCEEDED: 'Text extraction result exceeds the configured page limit',
  DOCUMENT_TOO_LARGE: 'Document is too large for text extraction',
  UNSUPPORTED_DOCUMENT: 'Document format is not supported for text extraction',
  BAD_DOCUMENT: 'Document could not be read for text extraction',
};

/** Walks an error and its cause chain (bounded) looking for a detail value. */
function findDetail(error: unknown, key: string): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof DomainError && current.details?.[key] !== undefined) {
      return current.details[key];
    }
    current = current.cause;
  }
  return undefined;
}

/** True when the error (or any error in its cause chain) is marked as transient. */
export function isRetryable(error: unknown): boolean {
  return findDetail(error, 'retryable') === true;
}

export function deterministicFailureCode(error: unknown): DeterministicFailureCode | undefined {
  const code = findDetail(error, 'failureCode');
  return DETERMINISTIC_FAILURE_CODES.find((known) => known === code);
}

/**
 * Calls an adapter and converts any failure into an ExternalServiceError with a
 * stable, sanitised message. Transience and deterministic failure codes are preserved.
 */
export async function callAdapter<T>(stage: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (cause) {
    const failureCode = deterministicFailureCode(cause);
    const message =
      failureCode === undefined ? `${stage} failed` : DETERMINISTIC_FAILURE_MESSAGES[failureCode];
    throw new ExternalServiceError(
      message,
      {
        stage,
        retryable: isRetryable(cause),
        ...(failureCode === undefined ? {} : { failureCode }),
      },
      { cause },
    );
  }
}

/** Validates an adapter response so a faulty adapter cannot corrupt persisted state. */
export function parseAdapterResponse<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  stage: string,
): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ExternalServiceError(`${stage} returned an invalid response`, {
      stage,
      retryable: false,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}

/** Status reasons are visible through the API, so only our own sanitised messages are used. */
export function failureReason(error: unknown): string {
  return error instanceof ExternalServiceError ? error.message : 'Unexpected processing error';
}

export interface FailureDeps {
  readonly repository: DocumentRepository;
  readonly clock: Clock;
  readonly logger: Logger;
}

export interface FailureOptions {
  /** A submitted job to keep on the record (e.g. it could not be tracked). */
  readonly orphanedJob?: ExtractionJob;
  /** Overrides the reason derived from the error. Must be a sanitised message. */
  readonly reason?: string;
}

/**
 * Moves the latest stored version of a document to FAILED. Never throws: if
 * the failure itself cannot be persisted, that is logged as a stuck document
 * and the caller's original error remains the one reported.
 * Returns the failed record, or undefined if nothing was persisted.
 */
export async function recordProcessingFailure(
  deps: FailureDeps,
  documentId: string,
  error: unknown,
  options: FailureOptions = {},
): Promise<DocumentRecord | undefined> {
  const { repository, clock, logger } = deps;
  const reason = options.reason ?? failureReason(error);
  const failureCode = deterministicFailureCode(error) ?? 'GENERAL';
  try {
    const latest = await repository.findById(documentId);
    if (latest?.status !== 'PROCESSING' && latest?.status !== 'EXTRACTING') {
      // Already resolved elsewhere (or gone); nothing to record.
      return undefined;
    }
    const now = clock.now();
    const failed: DocumentRecord = {
      ...transitionDocument(latest, 'FAILED', now, reason),
      lastFailure: { code: failureCode, at: now },
      ...(options.orphanedJob === undefined ? {} : { extractionJob: options.orphanedJob }),
    };
    await repository.save(failed);
    logger.error(
      {
        documentId,
        reason,
        failureCode,
        retryable: isRetryable(error),
        err: error,
      },
      'Document processing failed',
    );
    return failed;
  } catch (persistError) {
    logger.error(
      {
        documentId,
        reason,
        failureCode,
        err: error,
        persistError,
        stuck: true,
      },
      'Could not record processing failure; document may be stuck in a processing state',
    );
    return undefined;
  }
}
