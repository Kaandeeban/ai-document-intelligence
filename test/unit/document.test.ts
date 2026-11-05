import { describe, expect, it } from 'vitest';
import {
  canTransition,
  createDocument,
  storageKeyFor,
  transitionDocument,
} from '../../src/domain/document.js';
import { InvalidStatusTransitionError } from '../../src/domain/errors.js';

const t0 = new Date('2026-01-01T00:00:00Z');
const t1 = new Date('2026-01-01T00:00:01Z');

const newDoc = () =>
  createDocument({
    id: '6f1c2c1e-6c1a-4a8e-9a43-1f0d6f2a9b10',
    originalFilename: 'invoice.pdf',
    fileType: 'pdf',
    mimeType: 'application/pdf',
    sizeBytes: 10,
    sha256: 'abc',
    now: t0,
  });

describe('document lifecycle', () => {
  it('starts in RECEIVED with one history entry and a server-derived storage key', () => {
    const doc = newDoc();
    expect(doc.status).toBe('RECEIVED');
    expect(doc.statusHistory).toEqual([{ status: 'RECEIVED', at: t0 }]);
    expect(doc.storageKey).toBe(storageKeyFor(doc.id, 'pdf'));
    expect(doc.storageKey).not.toContain('invoice');
  });

  it('appends transitions immutably and records reasons', () => {
    const doc = newDoc();
    const failed = transitionDocument(doc, 'FAILED', t1, 'boom');
    expect(failed.status).toBe('FAILED');
    expect(failed.updatedAt).toBe(t1);
    expect(failed.statusHistory.at(-1)).toEqual({ status: 'FAILED', at: t1, reason: 'boom' });
    expect(doc.status).toBe('RECEIVED');
  });

  it('allows retry from FAILED but nothing after PROCESSED', () => {
    expect(canTransition('FAILED', 'PROCESSING')).toBe(true);
    expect(canTransition('PROCESSED', 'PROCESSING')).toBe(false);
    expect(canTransition('RECEIVED', 'PROCESSED')).toBe(false);
  });

  it('throws on illegal transitions', () => {
    expect(() => transitionDocument(newDoc(), 'PROCESSED', t1)).toThrow(
      InvalidStatusTransitionError,
    );
  });
});
