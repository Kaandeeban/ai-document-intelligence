/** Test wiring for application services with local adapters and controllable time. */
import { vi } from 'vitest';
import type {
  CapacityReservation,
  CompletionScheduler,
  DocumentClassifier,
  Logger,
  TextExtractor,
} from '../../src/application/ports/index.js';
import {
  CompleteExtractionService,
  type CompletionPolicy,
} from '../../src/application/services/complete-extraction.js';
import { ExtractionFinalizer } from '../../src/application/services/extraction-finalizer.js';
import { IngestDocumentService } from '../../src/application/services/ingest-document.js';
import { ProcessDocumentService } from '../../src/application/services/process-document.js';
import type { ExtractionResult } from '../../src/domain/processing.js';
import {
  InMemoryDocumentRepository,
  InMemoryDocumentStorage,
  KeywordDocumentClassifier,
} from '../../src/infrastructure/local-adapters.js';
import { pdfBytes, pngBytes } from './fixtures.js';

export const silentLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

export class FakeClock {
  constructor(private current = new Date('2026-01-01T00:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

/** Records scheduling requests instead of running timers. */
export class ManualScheduler implements CompletionScheduler {
  readonly scheduled: { documentId: string; delayMs: number; reserved: boolean }[] = [];
  capacity = true;
  reservations = 0;
  /** Reservations currently held (reserved, not yet released or consumed). */
  outstanding = new Set<CapacityReservation>();
  reserve(): CapacityReservation | undefined {
    if (!this.capacity) return undefined;
    this.reservations += 1;
    const reservation: CapacityReservation = {
      release: () => {
        this.outstanding.delete(reservation);
      },
    };
    this.outstanding.add(reservation);
    return reservation;
  }
  schedule(documentId: string, delayMs: number, reservation?: CapacityReservation): void {
    if (reservation) this.outstanding.delete(reservation);
    this.scheduled.push({ documentId, delayMs, reserved: reservation !== undefined });
  }
}

export const ocrResult = (overrides: Partial<ExtractionResult> = {}): ExtractionResult => ({
  provider: 'fake-ocr',
  text: 'INVOICE #1',
  pageCount: 1,
  confidence: 0.9,
  lines: [{ page: 1, text: 'INVOICE #1', confidence: 0.9 }],
  warnings: [],
  ...overrides,
});

/** Synchronous fake OCR (like the image path). */
export const syncExtractor = (result: ExtractionResult = ocrResult()): TextExtractor => ({
  isAsynchronous: () => false,
  start: () => Promise.resolve({ status: 'COMPLETED', result }),
  check: () => Promise.reject(new Error('no async jobs')),
});

export const DEFAULT_POLICY: CompletionPolicy = {
  initialDelayMs: 1_000,
  maxDelayMs: 8_000,
  jobTimeoutMs: 60_000,
};

let counter = 0;
const ids = { newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` };

export interface TestServicesOptions {
  extractor?: TextExtractor;
  classifier?: DocumentClassifier;
  policy?: CompletionPolicy;
}

export function createTestServices(options: TestServicesOptions = {}) {
  const logWarn = vi.fn();
  const logError = vi.fn();
  const logger: Logger = { info: vi.fn(), warn: logWarn, error: logError };
  const clock = new FakeClock();
  const repository = new InMemoryDocumentRepository();
  const storage = new InMemoryDocumentStorage();
  const scheduler = new ManualScheduler();
  const extractor = options.extractor ?? syncExtractor();
  const classifier = options.classifier ?? new KeywordDocumentClassifier();
  const policy = options.policy ?? DEFAULT_POLICY;

  const ingest = new IngestDocumentService({
    repository,
    storage,
    clock,
    ids,
    logger,
    maxUploadBytes: 4096,
  });
  const finalizer = new ExtractionFinalizer({ repository, storage, classifier, clock, logger });
  const process = new ProcessDocumentService({
    repository,
    extractor,
    finalizer,
    scheduler,
    clock,
    logger,
    initialCheckDelayMs: policy.initialDelayMs,
  });
  const complete = new CompleteExtractionService({
    repository,
    extractor,
    finalizer,
    clock,
    logger,
    policy,
  });

  const ingestPdf = () =>
    ingest.execute({ filename: 'a.pdf', declaredMimeType: 'application/pdf', content: pdfBytes() });
  const ingestPng = () =>
    ingest.execute({ filename: 'a.png', declaredMimeType: 'image/png', content: pngBytes() });

  return {
    logger,
    logWarn,
    logError,
    clock,
    repository,
    storage,
    scheduler,
    ingest,
    process,
    complete,
    ingestPdf,
    ingestPng,
  };
}
