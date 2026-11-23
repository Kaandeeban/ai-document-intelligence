/**
 * Local adapters: no network or cloud access. Used by default for development
 * and tests. Each implements a port so it can be swapped for an AWS or
 * PostgreSQL adapter without changing application code.
 */
import { randomUUID } from 'node:crypto';
import type {
  ClassificationRequest,
  Clock,
  DocumentClassifier,
  DocumentRepository,
  DocumentStorage,
  ExtractionJobRequest,
  IdGenerator,
  PutObjectOptions,
  TextExtractionRequest,
  TextExtractor,
} from '../application/ports/index.js';
import type { DocumentRecord } from '../domain/document.js';
import { ConcurrentModificationError } from '../domain/errors.js';
import type {
  ClassificationResult,
  DocumentClass,
  ExtractionCheck,
  ExtractionStart,
} from '../domain/processing.js';

/**
 * In-memory repository with optimistic concurrency. Data is lost on restart.
 */
export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly records = new Map<string, DocumentRecord>();

  save(document: DocumentRecord): Promise<void> {
    const stored = this.records.get(document.id);
    const expectedVersion = stored ? stored.version + 1 : 1;
    if (document.version !== expectedVersion) {
      return Promise.reject(
        new ConcurrentModificationError('Document was modified concurrently', {
          documentId: document.id,
        }),
      );
    }
    // Clone so callers cannot mutate stored state by reference.
    this.records.set(document.id, structuredClone(document));
    return Promise.resolve();
  }

  findById(id: string): Promise<DocumentRecord | undefined> {
    const record = this.records.get(id);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }
}

export class ObjectAlreadyExistsError extends Error {
  override readonly name = 'ObjectAlreadyExistsError';
}

export class InMemoryDocumentStorage implements DocumentStorage {
  private readonly objects = new Map<string, { content: Uint8Array; contentType: string }>();

  put(key: string, content: Uint8Array, options: PutObjectOptions): Promise<void> {
    if (options.overwrite !== true && this.objects.has(key)) {
      return Promise.reject(new ObjectAlreadyExistsError('Object already exists'));
    }
    this.objects.set(key, { content: new Uint8Array(content), contentType: options.contentType });
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | undefined> {
    const object = this.objects.get(key);
    return Promise.resolve(object ? new Uint8Array(object.content) : undefined);
  }
}

/**
 * Synchronous placeholder OCR: confirms the object exists and returns no text.
 * Used when EXTRACTOR_DRIVER=stub.
 */
export class StubTextExtractor implements TextExtractor {
  constructor(private readonly storage: DocumentStorage) {}

  isAsynchronous(): boolean {
    return false;
  }

  async start(request: TextExtractionRequest): Promise<ExtractionStart> {
    const content = await this.storage.get(request.storageKey);
    if (!content) {
      throw new Error(`Stored object not found for document ${request.documentId}`);
    }
    return {
      status: 'COMPLETED',
      result: {
        provider: 'stub',
        text: '',
        pageCount: 1,
        confidence: 0,
        lines: [],
        warnings: ['STUB_EXTRACTOR'],
      },
    };
  }

  check(request: ExtractionJobRequest): Promise<ExtractionCheck> {
    // The stub never starts asynchronous jobs, so any job ID is unknown.
    return Promise.reject(new Error(`Unknown extraction job ${request.jobId}`));
  }
}

const KEYWORDS: readonly [DocumentClass, RegExp][] = [
  ['CREDIT_NOTE', /\bcredit\s+note\b/i],
  ['PURCHASE_ORDER', /\bpurchase\s+order\b/i],
  ['RECEIPT', /\breceipt\b/i],
  ['INVOICE', /\binvoice\b/i],
];

/** Deterministic keyword classifier; stands in for Bedrock until Milestone 3. */
export class KeywordDocumentClassifier implements DocumentClassifier {
  classify(request: ClassificationRequest): Promise<ClassificationResult> {
    const match = KEYWORDS.find(([, pattern]) => pattern.test(request.text));
    return Promise.resolve({
      provider: 'keyword',
      modelVersion: 'keyword-v1',
      promptVersion: 'n/a',
      documentClass: match?.[0] ?? 'OTHER',
      confidence: match ? 0.5 : 0,
    });
  }
}

export const systemClock: Clock = { now: () => new Date() };

export const uuidGenerator: IdGenerator = { newId: () => randomUUID() };
