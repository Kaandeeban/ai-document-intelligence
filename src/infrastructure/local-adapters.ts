/**
 * Milestone 1 local adapters. No network or cloud access. Each one implements
 * a port so it can be swapped for an AWS/PostgreSQL adapter later.
 */
import { randomUUID } from 'node:crypto';
import type {
  ClassificationRequest,
  Clock,
  DocumentClassifier,
  DocumentRepository,
  DocumentStorage,
  IdGenerator,
  TextExtractionRequest,
  TextExtractor,
} from '../application/ports/index.js';
import type { DocumentRecord } from '../domain/document.js';
import type {
  ClassificationResult,
  DocumentClass,
  ExtractionResult,
} from '../domain/processing.js';

export class InMemoryDocumentRepository implements DocumentRepository {
  private readonly records = new Map<string, DocumentRecord>();

  save(document: DocumentRecord): Promise<void> {
    // Clone so callers cannot mutate stored state by reference.
    this.records.set(document.id, structuredClone(document));
    return Promise.resolve();
  }

  findById(id: string): Promise<DocumentRecord | undefined> {
    const record = this.records.get(id);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }
}

export class InMemoryDocumentStorage implements DocumentStorage {
  private readonly objects = new Map<string, Uint8Array>();

  put(key: string, content: Uint8Array): Promise<void> {
    this.objects.set(key, new Uint8Array(content));
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | undefined> {
    const object = this.objects.get(key);
    return Promise.resolve(object ? new Uint8Array(object) : undefined);
  }
}

/** Placeholder until Textract (Milestone 2): confirms the object exists and returns no text. */
export class StubTextExtractor implements TextExtractor {
  constructor(private readonly storage: DocumentStorage) {}

  async extract(request: TextExtractionRequest): Promise<ExtractionResult> {
    const content = await this.storage.get(request.storageKey);
    if (!content) {
      throw new Error(`Stored object not found for document ${request.documentId}`);
    }
    return { provider: 'stub', text: '', pageCount: 1, confidence: 0 };
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
