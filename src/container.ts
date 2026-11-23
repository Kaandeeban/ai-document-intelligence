/**
 * Composition root: the single place where concrete adapters are chosen (from
 * configuration) and wired into application services. Manual constructor
 * injection, no framework. AWS SDK clients are created only here.
 */
import type {
  Clock,
  CompletionScheduler,
  DocumentClassifier,
  DocumentRepository,
  DocumentStorage,
  IdGenerator,
  Logger,
  TextExtractor,
} from './application/ports/index.js';
import { CompleteExtractionService } from './application/services/complete-extraction.js';
import { ExtractionFinalizer } from './application/services/extraction-finalizer.js';
import { GetDocumentService } from './application/services/get-document.js';
import { IngestDocumentService } from './application/services/ingest-document.js';
import { ProcessDocumentService } from './application/services/process-document.js';
import type { AppConfig } from './config/env.js';
import { createAwsClients, type AwsClients } from './infrastructure/aws/aws-clients.js';
import { S3DocumentStorage } from './infrastructure/aws/s3-document-storage.js';
import {
  TEXTRACT_SYNC_IMAGE_LIMITS,
  TextractTextExtractor,
} from './infrastructure/aws/textract-text-extractor.js';
import {
  InProcessCompletionScheduler,
  type CompletionHandler,
} from './infrastructure/in-process-completion-scheduler.js';
import {
  InMemoryDocumentRepository,
  InMemoryDocumentStorage,
  KeywordDocumentClassifier,
  StubTextExtractor,
  systemClock,
  uuidGenerator,
} from './infrastructure/local-adapters.js';

export interface Adapters {
  readonly repository: DocumentRepository;
  readonly storage: DocumentStorage;
  readonly extractor: TextExtractor;
  readonly classifier: DocumentClassifier;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface Services {
  readonly ingestDocument: IngestDocumentService;
  readonly getDocument: GetDocumentService;
  readonly processDocument: ProcessDocumentService;
  readonly completeExtraction: CompleteExtractionService;
}

/** A scheduler plus its shutdown hook; the factory receives the completion handler. */
export type SchedulerFactory = (
  handler: CompletionHandler,
) => CompletionScheduler & { close(): Promise<void> };

export interface ApplicationOverrides extends Partial<Adapters> {
  readonly schedulerFactory?: SchedulerFactory;
}

export interface Application {
  readonly services: Services;
  readonly adapters: Adapters;
  /** Stops background completion checks and releases AWS clients. */
  close(): Promise<void>;
}

/** Selects adapters from configuration. Explicit overrides (tests) take precedence. */
export function createAdapters(
  config: AppConfig,
  overrides: Partial<Adapters> = {},
): { adapters: Adapters; aws: AwsClients | undefined } {
  const { storage: storageConfig, extraction } = config;
  const needsAws =
    (storageConfig.driver === 's3' && overrides.storage === undefined) ||
    (extraction.driver === 'textract' && overrides.extractor === undefined);
  const aws = needsAws ? createAwsClients(config.aws) : undefined;

  const storage =
    overrides.storage ??
    (storageConfig.driver === 's3' && aws
      ? new S3DocumentStorage(aws.s3, {
          bucket: storageConfig.bucket,
          ...(storageConfig.kmsKeyId === undefined ? {} : { kmsKeyId: storageConfig.kmsKeyId }),
        })
      : new InMemoryDocumentStorage());

  let extractor = overrides.extractor;
  if (!extractor) {
    if (extraction.driver === 'textract') {
      // Config validation guarantees textract ⇒ s3 storage.
      if (storageConfig.driver !== 's3' || !aws) {
        throw new Error('EXTRACTOR_DRIVER=textract requires STORAGE_DRIVER=s3');
      }
      extractor = new TextractTextExtractor(aws.textract, {
        bucket: storageConfig.bucket,
        maxResultPages: extraction.maxResultPages,
      });
    } else {
      extractor = new StubTextExtractor(storage);
    }
  }

  return {
    aws,
    adapters: {
      repository: overrides.repository ?? new InMemoryDocumentRepository(),
      storage,
      extractor,
      classifier: overrides.classifier ?? new KeywordDocumentClassifier(),
      clock: overrides.clock ?? systemClock,
      ids: overrides.ids ?? uuidGenerator,
    },
  };
}

export function createApplication(
  config: AppConfig,
  logger: Logger,
  overrides: ApplicationOverrides = {},
): Application {
  const { schedulerFactory, ...adapterOverrides } = overrides;
  const { adapters, aws } = createAdapters(config, adapterOverrides);
  const { repository, storage, extractor, classifier, clock, ids } = adapters;
  const { extraction } = config;

  const finalizer = new ExtractionFinalizer({ repository, storage, classifier, clock, logger });
  const completeExtraction = new CompleteExtractionService({
    repository,
    extractor,
    finalizer,
    clock,
    logger,
    policy: {
      initialDelayMs: extraction.pollInitialDelayMs,
      maxDelayMs: extraction.pollMaxDelayMs,
      jobTimeoutMs: extraction.jobTimeoutMs,
    },
  });

  const handler: CompletionHandler = (documentId) => completeExtraction.execute(documentId);
  const scheduler =
    schedulerFactory?.(handler) ??
    (() => {
      const inProcess = new InProcessCompletionScheduler({
        maxTrackedJobs: extraction.maxPendingJobs,
        logger,
      });
      inProcess.setHandler(handler);
      return inProcess;
    })();

  const services: Services = {
    ingestDocument: new IngestDocumentService({
      repository,
      storage,
      clock,
      ids,
      logger,
      maxUploadBytes: config.maxUploadBytes,
      ...(extraction.driver === 'textract' ? { maxBytesByType: TEXTRACT_SYNC_IMAGE_LIMITS } : {}),
    }),
    getDocument: new GetDocumentService(repository),
    processDocument: new ProcessDocumentService({
      repository,
      extractor,
      finalizer,
      scheduler,
      clock,
      logger,
      initialCheckDelayMs: extraction.pollInitialDelayMs,
    }),
    completeExtraction,
  };

  return {
    services,
    adapters,
    close: async () => {
      // Wait (bounded) for in-flight completion checks before destroying the
      // AWS clients they use.
      await scheduler.close();
      aws?.destroy();
    },
  };
}
