import { InvalidStatusTransitionError } from './errors.js';
import type { SupportedFileType } from './file-type.js';
import type { ProcessingOutcome } from './processing.js';

export const DOCUMENT_STATUSES = [
  'RECEIVED',
  'STORED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

const ALLOWED_TRANSITIONS: Readonly<Record<DocumentStatus, readonly DocumentStatus[]>> = {
  RECEIVED: ['STORED', 'FAILED'],
  STORED: ['PROCESSING', 'FAILED'],
  PROCESSING: ['PROCESSED', 'FAILED'],
  PROCESSED: [],
  FAILED: ['PROCESSING'], // retry
};

export interface StatusChange {
  readonly status: DocumentStatus;
  readonly at: Date;
  readonly reason?: string;
}

export interface DocumentRecord {
  readonly id: string;
  readonly originalFilename: string;
  readonly fileType: SupportedFileType;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly storageKey: string;
  readonly status: DocumentStatus;
  readonly statusHistory: readonly StatusChange[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly processing?: ProcessingOutcome;
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
    storageKey: storageKeyFor(input.id, input.fileType),
    status: 'RECEIVED',
    statusHistory: [{ status: 'RECEIVED', at: now }],
    createdAt: now,
    updatedAt: now,
  };
}

export function canTransition(from: DocumentStatus, to: DocumentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
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
    status: to,
    statusHistory: [...document.statusHistory, change],
    updatedAt: at,
  };
}
