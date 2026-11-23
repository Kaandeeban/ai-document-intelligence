/**
 * Ports: the only way the application layer talks to the outside world.
 * Adapters (in-memory, stub, S3, Textract, and later PostgreSQL/Bedrock) live in
 * the infrastructure layer and are selected in the composition root.
 */
import type { DocumentRecord } from '../../domain/document.js';
import type { SupportedFileType } from '../../domain/file-type.js';
import type {
  ClassificationResult,
  ExtractionCheck,
  ExtractionStart,
} from '../../domain/processing.js';

/**
 * Persistence of document metadata (future: PostgreSQL).
 * `save` enforces optimistic concurrency: a new record must have version 1 and
 * an update must have exactly stored version + 1, otherwise it rejects with
 * ConcurrentModificationError.
 */
export interface DocumentRepository {
  save(document: DocumentRecord): Promise<void>;
  findById(id: string): Promise<DocumentRecord | undefined>;
}

export interface PutObjectOptions {
  readonly contentType: string;
  /** Hex SHA-256 of the content; adapters may use it for integrity verification. */
  readonly sha256Hex?: string;
  readonly metadata?: Readonly<Record<string, string>>;
  /** Defaults to false: an existing object at the same key is never replaced. */
  readonly overwrite?: boolean;
}

/** Binary document storage. Keys are opaque, server-generated strings. */
export interface DocumentStorage {
  put(key: string, content: Uint8Array, options: PutObjectOptions): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
}

export interface TextExtractionRequest {
  readonly documentId: string;
  readonly storageKey: string;
  readonly fileType: SupportedFileType;
  /** Processing attempt number; adapters use it to make job submission idempotent per attempt. */
  readonly attempt: number;
}

export interface ExtractionJobRequest {
  readonly documentId: string;
  readonly jobId: string;
}

/**
 * Two-phase OCR. `start` either completes synchronously or starts a job;
 * `check` reports the state of a started job. The adapter decides which.
 */
export interface TextExtractor {
  /**
   * Whether `start` will begin an asynchronous job for this file type.
   * Synchronous and side-effect free; used to reserve capacity before submission.
   */
  isAsynchronous(fileType: SupportedFileType): boolean;
  start(request: TextExtractionRequest): Promise<ExtractionStart>;
  check(request: ExtractionJobRequest): Promise<ExtractionCheck>;
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

/**
 * Decides when a pending OCR job is checked again. Milestone 2: in-process
 * timers. Milestone 4: replaced by SNS/SQS completion notifications.
 */
export interface CompletionScheduler {
  /**
   * Atomically (synchronously) reserves one tracking slot for an asynchronous
   * job, or returns undefined when at capacity or shutting down. Must be called
   * before submitting a billable job.
   */
  reserve(): CapacityReservation | undefined;
  /**
   * Starts tracking a submitted job, consuming the reservation. Without a
   * reservation (e.g. a job that started unexpectedly) the job is still
   * tracked, even beyond capacity, so it is never abandoned.
   */
  schedule(documentId: string, delayMs: number, reservation?: CapacityReservation): void;
}

export interface CapacityReservation {
  /** Returns the slot. Idempotent; a no-op once the reservation was consumed by `schedule`. */
  release(): void;
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
