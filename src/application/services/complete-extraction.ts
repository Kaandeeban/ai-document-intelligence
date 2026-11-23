import { reviseDocument, transitionDocument, type DocumentRecord } from '../../domain/document.js';
import { ConcurrentModificationError, ExternalServiceError } from '../../domain/errors.js';
import { extractionCheckSchema, type ExtractionFailureReason } from '../../domain/processing.js';
import type { Clock, DocumentRepository, Logger, TextExtractor } from '../ports/index.js';
import type { ExtractionFinalizer } from './extraction-finalizer.js';
import {
  callAdapter,
  isRetryable,
  parseAdapterResponse,
  recordProcessingFailure,
} from './processing-support.js';

export interface CompletionPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  /** Measured from job start; once exceeded the document is marked FAILED. */
  readonly jobTimeoutMs: number;
}

export type CompletionOutcome =
  | { readonly state: 'PENDING'; readonly nextCheckInMs: number }
  | { readonly state: 'COMPLETED' }
  | { readonly state: 'FAILED' }
  /** Nothing to do: unknown document, not EXTRACTING, or handled concurrently. */
  | { readonly state: 'IGNORED' };

export interface CompleteExtractionDeps {
  readonly repository: DocumentRepository;
  readonly extractor: TextExtractor;
  readonly finalizer: ExtractionFinalizer;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly policy: CompletionPolicy;
}

const FAILURE_MESSAGES: Readonly<Record<ExtractionFailureReason, string>> = {
  JOB_FAILED: 'Text extraction job failed',
  PARTIAL_SUCCESS: 'Text extraction only partially succeeded',
};

/**
 * Performs exactly one status check of an asynchronous OCR job and advances the
 * document. Owns the timeout and backoff policy, so any trigger (in-process
 * scheduler now, SNS/SQS worker later) gets identical behaviour. Never throws
 * for expected failures; they are recorded on the document instead.
 */
export class CompleteExtractionService {
  constructor(private readonly deps: CompleteExtractionDeps) {}

  async execute(documentId: string): Promise<CompletionOutcome> {
    const { repository, extractor, finalizer, clock, logger, policy } = this.deps;
    const document = await repository.findById(documentId);
    const job = document?.extractionJob;
    if (document?.status !== 'EXTRACTING' || !job) {
      return { state: 'IGNORED' };
    }

    const now = clock.now();
    const elapsedMs = now.getTime() - job.startedAt.getTime();
    const timedOut = elapsedMs >= policy.jobTimeoutMs;

    try {
      let check;
      try {
        const raw = await callAdapter('Text extraction status check', () =>
          extractor.check({ documentId, jobId: job.jobId }),
        );
        check = parseAdapterResponse(extractionCheckSchema, raw, 'Text extraction status check');
      } catch (error) {
        if (isRetryable(error) && !timedOut) {
          logger.warn({ documentId, checks: job.checks }, 'Transient error checking OCR job');
          return await this.pending(document, now, elapsedMs);
        }
        throw error;
      }

      switch (check.status) {
        case 'IN_PROGRESS':
          if (timedOut) {
            throw new ExternalServiceError('Text extraction timed out', {
              documentId,
              elapsedMs,
            });
          }
          return await this.pending(document, now, elapsedMs);
        case 'FAILED':
          throw new ExternalServiceError(FAILURE_MESSAGES[check.reason], {
            documentId,
            reason: check.reason,
          });
        case 'COMPLETED': {
          const processing = transitionDocument(document, 'PROCESSING', now);
          await repository.save(processing);
          await finalizer.finalize(processing, check.result, job.startedAt);
          return { state: 'COMPLETED' };
        }
      }
    } catch (error) {
      if (error instanceof ConcurrentModificationError) {
        logger.info({ documentId }, 'OCR completion already handled concurrently');
        return { state: 'IGNORED' };
      }
      // Never throws; a failure to persist FAILED is logged as a stuck document.
      await recordProcessingFailure(this.deps, documentId, error);
      return { state: 'FAILED' };
    }
  }

  private async pending(
    document: DocumentRecord,
    now: Date,
    elapsedMs: number,
  ): Promise<CompletionOutcome> {
    const { policy } = this.deps;
    const job = document.extractionJob;
    if (!job) return { state: 'IGNORED' };
    const checks = job.checks + 1;
    await this.deps.repository.save(
      reviseDocument(document, { extractionJob: { ...job, checks, lastCheckedAt: now } }, now),
    );
    // Exponential backoff, capped, and never scheduled beyond the job deadline.
    const backoff = Math.min(policy.initialDelayMs * 2 ** checks, policy.maxDelayMs);
    const remaining = policy.jobTimeoutMs - elapsedMs;
    return { state: 'PENDING', nextCheckInMs: Math.max(1, Math.min(backoff, remaining)) };
  }
}
