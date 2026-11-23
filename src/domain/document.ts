import { InvalidStatusTransitionError } from './errors.js';
import type { SupportedFileType } from './file-type.js';
import type { ProcessingOutcome } from './processing.js';

export const DOCUMENT_STATUSES = [
  'RECEIVED',
  'STORED',
  'PROCESSING',
  'EXTRACTING',
  'PROCESSED',
  'FAILED',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  RECEIVED: ['STORED', 'FAILED'],
  STORED: ['PROCESSING', 'FAILED'],
  // EXTRACTING: asynchronous OCR job started; PROCESSED: synchronous OCR + classification done.
  PROCESSING: ['EXTRACTING', 'PROCESSED', 'FAILED'],
  // PROCESSING: OCR job finished, classification follows.
  EXTRACTING: ['PROCESSING', 'FAILED'],
  PROCESSED: [],
  FAILED: ['PROCESSING'], // retry
};

/**
 * Failure codes that will recur on every attempt for the same document.
 * Reprocessing is refused so that no further billable OCR jobs are submitted.
 */
export const DETERMINISTIC_FAILURE_CODES = [
  'RESULT_LIMIT_EXCEEDED',
  'DOCUMENT_TOO_LARGE',
  'UNSUPPORTED_DOCUMENT',
  'BAD_DOCUMENT',
] as const;
export type DeterministicFailureCode = (typeof DETERMINISTIC_FAILURE_CODES)[number];

export interface ProcessingFailure {
  /** A deterministic failure code, or 'GENERAL' for failures that may succeed on retry. */
  readonly code: DeterministicFailureCode | 'GENERAL';
  readonly at: Date;
}

export interface StatusChange {
  readonly status: DocumentStatus;
  readonly at: Date;
  readonly reason?: string;
}

/** Tracks an in-flight asynchronous OCR job. Internal; never exposed through the API. */
export interface ExtractionJob {
  readonly provider: string;
  readonly jobId: string;
  readonly startedAt: Date;
  readonly checks: number;
  readonly lastCheckedAt?: Date;
}

export interface DocumentRecord {
  readonly id: string;
  /** Incremented on every change; used for optimistic concurrency control. */
  readonly version: number;
  readonly originalFilename: string;
  readonly fileType: SupportedFileType;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly status: DocumentStatus;
  readonly statusHistory: readonly StatusChange[];
  readonly processingAttempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly extractionJob?: ExtractionJob;
  readonly processing?: ProcessingOutcome;
  /** Set when the document enters FAILED during processing. Internal. */
  readonly lastFailure?: ProcessingFailure;
}

export interface NewDocument {
  readonly id: string;
  readonly originalFilename: string;
  readonly fileType: SupportedFileType;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly now: Date;
}

const STORAGE_EXTENSION: Readonly<Record<SupportedFileType, string>> = {
  pdf: 'pdf',
  png: 'png',
  jpeg: 'jpg',
};

/** Storage keys derive only from server-generated values, never from user input. */
export function storageKeyFor(id: string, fileType: SupportedFileType): string {
  return `documents/${id}/original.${STORAGE_EXTENSION[fileType]}`;
}

export function createDocument(input: NewDocument): DocumentRecord {
  const { now, ...rest } = input;
  return {
    ...rest,
    version: 1,
    storageKey: storageKeyFor(input.id, input.fileType),
    status: 'RECEIVED',
    statusHistory: [{ status: 'RECEIVED', at: now }],
    processingAttempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type ProcessingEligibility =
  { readonly allowed: true } | { readonly allowed: false; readonly reason: string };

/**
 * Whether a client may (re)start processing. Stricter than the state machine:
 * - STORED: first attempt.
 * - FAILED: retry, but only if the original was stored (an upload that failed
 *   before STORED has nothing to process) and the last failure is not one that
 *   would deterministically recur (avoids repeated billable OCR submissions).
 */
export function processingEligibility(document: DocumentRecord): ProcessingEligibility {
  if (document.status === 'STORED') return { allowed: true };
  if (document.status !== 'FAILED') {
    return { allowed: false, reason: `Document cannot be processed while ${document.status}` };
  }
  if (!document.statusHistory.some((change) => change.status === 'STORED')) {
    return { allowed: false, reason: 'Document was never stored and cannot be processed' };
  }
  const code = document.lastFailure?.code;
  if (code !== undefined && code !== 'GENERAL') {
    return {
      allowed: false,
      reason: 'Document cannot be reprocessed: the previous failure would recur',
    };
  }
  return { allowed: true };
}

/** Returns a new record in the target status with the change appended to its audit history. */
export function transitionDocument(
  document: DocumentRecord,
  to: DocumentStatus,
  at: Date,
  reason?: string,
): DocumentRecord {
  if (!canTransition(document.status, to)) {
    throw new InvalidStatusTransitionError(
      `Cannot move document from ${document.status} to ${to}`,
      {
        documentId: document.id,
        from: document.status,
        to,
      },
    );
  }
  const change: StatusChange =
    reason === undefined ? { status: to, at } : { status: to, at, reason };
  return {
    ...document,
    version: document.version + 1,
    status: to,
    statusHistory: [...document.statusHistory, change],
    updatedAt: at,
  };
}

/** Applies a non-status change (e.g. job progress) as a new version of the record. */
export function reviseDocument(
  document: DocumentRecord,
  patch: Partial<Pick<DocumentRecord, 'extractionJob' | 'lastFailure'>>,
  at: Date,
): DocumentRecord {
  return { ...document, ...patch, version: document.version + 1, updatedAt: at };
}

/** Copy of the record without the previous failure (cleared when a retry starts). */
export function withoutLastFailure(document: DocumentRecord): DocumentRecord {
  const copy: { -readonly [K in keyof DocumentRecord]: DocumentRecord[K] } = { ...document };
  delete copy.lastFailure;
  return copy;
}
