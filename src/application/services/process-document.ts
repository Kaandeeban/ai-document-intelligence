import {
  processingEligibility,
  withoutLastFailure,
  transitionDocument,
  type DocumentRecord,
  type ExtractionJob,
} from '../../domain/document.js';
import {
  DocumentNotFoundError,
  ExternalServiceError,
  InvalidStatusTransitionError,
  ServiceUnavailableError,
} from '../../domain/errors.js';
import { extractionStartSchema } from '../../domain/processing.js';
import type {
  CapacityReservation,
  Clock,
  CompletionScheduler,
  DocumentRepository,
  Logger,
  TextExtractor,
} from '../ports/index.js';
import type { ExtractionFinalizer } from './extraction-finalizer.js';
import {
  callAdapter,
  parseAdapterResponse,
  recordProcessingFailure,
} from './processing-support.js';

export interface ProcessDocumentDeps {
  readonly repository: DocumentRepository;
  readonly extractor: TextExtractor;
  readonly finalizer: ExtractionFinalizer;
  readonly scheduler: CompletionScheduler;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Delay before the first status check of an asynchronous OCR job. */
  readonly initialCheckDelayMs: number;
}

/**
 * Starts processing a STORED or FAILED document.
 * - Synchronous OCR: completes extraction and classification, returns PROCESSED.
 * - Asynchronous OCR: records the job, schedules completion, returns EXTRACTING
 *   without waiting for the job.
 */
export class ProcessDocumentService {
  constructor(private readonly deps: ProcessDocumentDeps) {}

  async execute(id: string): Promise<DocumentRecord> {
    const { repository, extractor, scheduler } = this.deps;
    const existing = await repository.findById(id);
    if (!existing) {
      throw new DocumentNotFoundError('Document not found', { documentId: id });
    }
    const eligibility = processingEligibility(existing);
    if (!eligibility.allowed) {
      throw new InvalidStatusTransitionError(eligibility.reason, {
        documentId: id,
        status: existing.status,
      });
    }

    // Only asynchronous jobs occupy scheduler capacity. The slot is reserved
    // synchronously BEFORE any await, so concurrent requests cannot oversubscribe.
    let reservation: CapacityReservation | undefined;
    if (extractor.isAsynchronous(existing.fileType)) {
      reservation = scheduler.reserve();
      if (!reservation) {
        throw new ServiceUnavailableError('Processing capacity reached; retry later', {
          retryAfterSeconds: 30,
        });
      }
    }

    try {
      return await this.run(existing, reservation);
    } finally {
      // No-op if `schedule` consumed it; otherwise frees the slot on every
      // non-async outcome and on every failure path.
      reservation?.release();
    }
  }

  private async run(
    existing: DocumentRecord,
    reservation: CapacityReservation | undefined,
  ): Promise<DocumentRecord> {
    const { repository, extractor, finalizer, scheduler, clock, logger } = this.deps;
    const id = existing.id;
    const startedAt = clock.now();
    let document: DocumentRecord = {
      ...transitionDocument(withoutLastFailure(existing), 'PROCESSING', startedAt),
      processingAttempts: existing.processingAttempts + 1,
    };
    // Optimistic concurrency: a concurrent request for the same document fails
    // here with ConcurrentModificationError, before any OCR job is submitted.
    await repository.save(document);

    let submittedJob: ExtractionJob | undefined;
    try {
      const rawStart = await callAdapter('Text extraction', () =>
        extractor.start({
          documentId: id,
          storageKey: document.storageKey,
          fileType: document.fileType,
          attempt: document.processingAttempts,
        }),
      );
      const start = parseAdapterResponse(extractionStartSchema, rawStart, 'Text extraction');

      if (start.status === 'COMPLETED') {
        return await finalizer.finalize(document, start.result, startedAt);
      }

      submittedJob = { provider: start.provider, jobId: start.jobId, startedAt, checks: 0 };
      document = {
        ...transitionDocument(document, 'EXTRACTING', clock.now()),
        extractionJob: submittedJob,
      };
      await repository.save(document);
      scheduler.schedule(id, this.deps.initialCheckDelayMs, reservation);
      logger.info(
        { documentId: id, provider: start.provider, attempt: document.processingAttempts },
        'Asynchronous text extraction started',
      );
      return document;
    } catch (error) {
      if (submittedJob) {
        // The job was submitted (and is billable) but could not be tracked.
        // Durable recovery needs persistent job tracking (Milestones 4/5); until
        // then the job ID is logged and kept on the failed record for reconciliation.
        logger.warn(
          {
            documentId: id,
            provider: submittedJob.provider,
            jobId: submittedJob.jobId,
            attempt: document.processingAttempts,
          },
          'OCR job submitted but could not be tracked; it will not be collected',
        );
      }
      await recordProcessingFailure(this.deps, id, error, {
        ...(submittedJob === undefined
          ? {}
          : { orphanedJob: submittedJob, reason: 'Text extraction job could not be tracked' }),
      });
      throw error instanceof ExternalServiceError
        ? error
        : new ExternalServiceError(
            'Document processing failed',
            { documentId: id },
            { cause: error },
          );
    }
  }
}
