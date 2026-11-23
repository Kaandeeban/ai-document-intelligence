import { describe, expect, it, vi } from 'vitest';
import type { DocumentClassifier, TextExtractor } from '../../src/application/ports/index.js';
import {
  DocumentNotFoundError,
  ExternalServiceError,
  InvalidStatusTransitionError,
  UnsupportedFileTypeError,
} from '../../src/domain/errors.js';
import type { ClassificationResult } from '../../src/domain/processing.js';
import { pdfBytes, pngBytes } from '../support/fixtures.js';
import { createTestServices } from '../support/services.js';

const setup = (overrides: { extractor?: TextExtractor; classifier?: DocumentClassifier } = {}) =>
  createTestServices(overrides);

describe('IngestDocumentService', () => {
  it('stores content, records a checksum and moves to STORED', async () => {
    const { storage, ingestPdf } = setup();
    const doc = await ingestPdf();
    expect(doc.status).toBe('STORED');
    expect(doc.statusHistory.map((s) => s.status)).toEqual(['RECEIVED', 'STORED']);
    expect(doc.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await storage.get(doc.storageKey)).toEqual(new Uint8Array(pdfBytes()));
  });

  it('rejects invalid uploads before persisting anything', async () => {
    const { ingest, repository } = setup();
    const save = vi.spyOn(repository, 'save');
    await expect(
      ingest.execute({
        filename: 'a.pdf',
        declaredMimeType: 'application/pdf',
        content: pngBytes(),
      }),
    ).rejects.toThrow(UnsupportedFileTypeError);
    expect(save).not.toHaveBeenCalled();
  });

  it('marks the document FAILED when storage fails', async () => {
    const { ingest, storage, repository } = setup();
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('disk full'));
    const error = await ingest
      .execute({ filename: 'a.pdf', declaredMimeType: 'application/pdf', content: pdfBytes() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    const id = (error as ExternalServiceError).details?.documentId as string;
    expect((await repository.findById(id))?.status).toBe('FAILED');
  });
});

describe('ProcessDocumentService', () => {
  it('extracts, classifies and records model/prompt versions', async () => {
    const { ingestPdf, process } = setup();
    const doc = await process.execute((await ingestPdf()).id);
    expect(doc.status).toBe('PROCESSED');
    expect(doc.processing?.classification).toMatchObject({
      documentClass: 'INVOICE',
      modelVersion: 'keyword-v1',
      promptVersion: 'n/a',
    });
    expect(doc.processing?.extraction.characterCount).toBe(10);
  });

  it('throws NotFound for unknown documents', async () => {
    const { process } = setup();
    await expect(process.execute('missing')).rejects.toThrow(DocumentNotFoundError);
  });

  it('refuses to reprocess a PROCESSED document', async () => {
    const { ingestPdf, process } = setup();
    const { id } = await ingestPdf();
    await process.execute(id);
    await expect(process.execute(id)).rejects.toThrow(InvalidStatusTransitionError);
  });

  it('fails the document when an adapter returns a malformed response', async () => {
    const malformed = {
      provider: 'fake',
      text: 'x',
      pageCount: -1,
      confidence: 5,
    };
    const { ingestPdf, process, repository } = setup({
      extractor: {
        isAsynchronous: () => false,
        start: () => Promise.resolve({ status: 'COMPLETED', result: malformed }),
        check: () => Promise.reject(new Error('unused')),
      },
    });
    const { id } = await ingestPdf();
    await expect(process.execute(id)).rejects.toThrow(
      'Text extraction returned an invalid response',
    );
    const stored = await repository.findById(id);
    expect(stored?.status).toBe('FAILED');
    expect(stored?.statusHistory.at(-1)?.reason).toBe(
      'Text extraction returned an invalid response',
    );
  });

  it('wraps adapter exceptions and allows a retry from FAILED', async () => {
    const classify = vi
      .fn<DocumentClassifier['classify']>()
      .mockRejectedValueOnce(new Error('throttled'))
      .mockResolvedValueOnce({
        provider: 'fake',
        modelVersion: 'm1',
        promptVersion: 'p1',
        documentClass: 'RECEIPT',
        confidence: 0.7,
      } satisfies ClassificationResult);
    const { ingestPdf, process } = setup({ classifier: { classify } });
    const { id } = await ingestPdf();
    await expect(process.execute(id)).rejects.toThrow('Classification failed');
    const retried = await process.execute(id);
    expect(retried.status).toBe('PROCESSED');
    expect(retried.statusHistory.map((s) => s.status)).toEqual([
      'RECEIVED',
      'STORED',
      'PROCESSING',
      'FAILED',
      'PROCESSING',
      'PROCESSED',
    ]);
  });
});
