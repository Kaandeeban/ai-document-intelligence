/**
 * Ports: the only way the application layer talks to the outside world.
 * Milestone 1 ships in-memory/local adapters; later milestones add S3,
 * Textract, Bedrock and PostgreSQL adapters behind these same interfaces.
 */
import type { DocumentRecord } from '../../domain/document.js';
import type { SupportedFileType } from '../../domain/file-type.js';
import type { ClassificationResult, ExtractionResult } from '../../domain/processing.js';

/** Persistence of document metadata (future: PostgreSQL). */
export interface DocumentRepository {
  save(document: DocumentRecord): Promise<void>;
  findById(id: string): Promise<DocumentRecord | undefined>;
}

/** Binary document storage (future: S3). Keys are opaque, server-generated strings. */
export interface DocumentStorage {
  put(key: string, content: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
}

export interface TextExtractionRequest {
  readonly documentId: string;
  readonly storageKey: string;
  readonly fileType: SupportedFileType;
}

/** OCR / text extraction (future: Textract). */
export interface TextExtractor {
  extract(request: TextExtractionRequest): Promise<ExtractionResult>;
}

export interface ClassificationRequest {
  readonly documentId: string;
  /** Untrusted document content; adapters must treat it as data, never instructions. */
  readonly text: string;
}

/** Document classification (future: Bedrock). */
export interface DocumentClassifier {
  classify(request: ClassificationRequest): Promise<ClassificationResult>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  newId(): string;
}

/** Minimal structured-logging port; satisfied by pino / Fastify's logger. */
export interface Logger {
  info(context: Record<string, unknown>, message: string): void;
  warn(context: Record<string, unknown>, message: string): void;
  error(context: Record<string, unknown>, message: string): void;
}
