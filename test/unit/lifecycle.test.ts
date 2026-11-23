import { describe, expect, it } from 'vitest';
import {
  processingEligibility,
  canTransition,
  createDocument,
  reviseDocument,
  transitionDocument,
  type DocumentStatus,
} from '../../src/domain/document.js';
import {
  ConcurrentModificationError,
  InvalidStatusTransitionError,
} from '../../src/domain/errors.js';
import { InMemoryDocumentRepository } from '../../src/infrastructure/local-adapters.js';

const t0 = new Date('2026-01-01T00:00:00Z');
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

describe('Milestone 2 lifecycle', () => {
  it.each<[DocumentStatus, DocumentStatus, boolean]>([
    ['PROCESSING', 'EXTRACTING', true],
    ['PROCESSING', 'PROCESSED', true],
    ['EXTRACTING', 'PROCESSING', true],
    ['EXTRACTING', 'FAILED', true],
    ['EXTRACTING', 'PROCESSED', false],
    ['STORED', 'EXTRACTING', false],
    ['FAILED', 'EXTRACTING', false],
    ['PROCESSED', 'EXTRACTING', false],
  ])('%s → %s allowed: %s', (from, to, allowed) => {
    expect(canTransition(from, to)).toBe(allowed);
  });

  const walk = (...statuses: DocumentStatus[]) =>
    statuses.reduce((doc, status) => transitionDocument(doc, status, t0), newDoc());

  it('only lets clients start processing from STORED or a retryable FAILED', () => {
    expect(processingEligibility(walk('STORED')).allowed).toBe(true);
    expect(processingEligibility(walk('STORED', 'PROCESSING', 'FAILED')).allowed).toBe(true);
    for (const doc of [
      newDoc(),
      walk('STORED', 'PROCESSING'),
      walk('STORED', 'PROCESSING', 'EXTRACTING'),
      walk('STORED', 'PROCESSING', 'PROCESSED'),
    ]) {
      expect(processingEligibility(doc).allowed).toBe(false);
    }
  });

  it('refuses processing for a document whose upload failed before STORED (L3)', () => {
    const uploadFailed = walk('FAILED');
    expect(processingEligibility(uploadFailed)).toEqual({
      allowed: false,
      reason: 'Document was never stored and cannot be processed',
    });
  });

  it('refuses reprocessing after a deterministic failure but allows general retries (L5)', () => {
    const failed = walk('STORED', 'PROCESSING', 'FAILED');
    expect(
      processingEligibility({ ...failed, lastFailure: { code: 'GENERAL', at: t0 } }).allowed,
    ).toBe(true);
    for (const code of [
      'RESULT_LIMIT_EXCEEDED',
      'DOCUMENT_TOO_LARGE',
      'UNSUPPORTED_DOCUMENT',
      'BAD_DOCUMENT',
    ] as const) {
      expect(processingEligibility({ ...failed, lastFailure: { code, at: t0 } }).allowed).toBe(
        false,
      );
    }
  });

  it('walks the asynchronous path with an audit entry per transition', () => {
    let doc = newDoc();
    for (const status of [
      'STORED',
      'PROCESSING',
      'EXTRACTING',
      'PROCESSING',
      'PROCESSED',
    ] as const) {
      doc = transitionDocument(doc, status, t0);
    }
    expect(doc.statusHistory.map((s) => s.status)).toEqual([
      'RECEIVED',
      'STORED',
      'PROCESSING',
      'EXTRACTING',
      'PROCESSING',
      'PROCESSED',
    ]);
    expect(doc.version).toBe(6);
  });

  it('rejects skipping straight from EXTRACTING to PROCESSED', () => {
    let doc = newDoc();
    for (const status of ['STORED', 'PROCESSING', 'EXTRACTING'] as const) {
      doc = transitionDocument(doc, status, t0);
    }
    expect(() => transitionDocument(doc, 'PROCESSED', t0)).toThrow(InvalidStatusTransitionError);
  });

  it('bumps the version on non-status revisions', () => {
    const doc = newDoc();
    const revised = reviseDocument(
      doc,
      { extractionJob: { provider: 'p', jobId: 'j', startedAt: t0, checks: 1 } },
      t0,
    );
    expect(revised.version).toBe(doc.version + 1);
    expect(revised.status).toBe(doc.status);
  });
});

describe('InMemoryDocumentRepository optimistic concurrency', () => {
  it('accepts sequential versions and rejects stale writes', async () => {
    const repository = new InMemoryDocumentRepository();
    const doc = newDoc();
    await repository.save(doc);
    const stored = transitionDocument(doc, 'STORED', t0);
    await repository.save(stored);

    // A second writer that also read version 1 loses.
    const stale = transitionDocument(doc, 'FAILED', t0);
    await expect(repository.save(stale)).rejects.toThrow(ConcurrentModificationError);
    expect((await repository.findById(doc.id))?.status).toBe('STORED');
  });

  it('rejects creating a document twice', async () => {
    const repository = new InMemoryDocumentRepository();
    await repository.save(newDoc());
    await expect(repository.save(newDoc())).rejects.toThrow(ConcurrentModificationError);
  });
});
