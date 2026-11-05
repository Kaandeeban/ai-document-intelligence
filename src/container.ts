/**
 * Composition root: the single place where concrete adapters are chosen and
 * wired into application services (manual constructor injection, no framework).
 */
import type {
  Clock,
  DocumentClassifier,
  DocumentRepository,
  DocumentStorage,
  IdGenerator,
  Logger,
  TextExtractor,
} from './application/ports/index.js';
import { GetDocumentService } from './application/services/get-document.js';
import { IngestDocumentService } from './application/services/ingest-document.js';
import { ProcessDocumentService } from './application/services/process-document.js';
import type { AppConfig } from './config/env.js';
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
}

export function createLocalAdapters(overrides: Partial<Adapters> = {}): Adapters {
  const storage = overrides.storage ?? new InMemoryDocumentStorage();
  return {
    repository: new InMemoryDocumentRepository(),
    extractor: new StubTextExtractor(storage),
    classifier: new KeywordDocumentClassifier(),
    clock: systemClock,
    ids: uuidGenerator,
    ...overrides,
    storage,
  };
}

export function createServices(config: AppConfig, adapters: Adapters, logger: Logger): Services {
  return {
    ingestDocument: new IngestDocumentService({
      repository: adapters.repository,
      storage: adapters.storage,
      clock: adapters.clock,
      ids: adapters.ids,
      logger,
      maxUploadBytes: config.maxUploadBytes,
    }),
    getDocument: new GetDocumentService(adapters.repository),
    processDocument: new ProcessDocumentService({
      repository: adapters.repository,
      extractor: adapters.extractor,
      classifier: adapters.classifier,
      clock: adapters.clock,
      logger,
    }),
  };
}
