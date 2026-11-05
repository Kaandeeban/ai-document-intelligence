import { describe, expect, it, vi } from 'vitest';
import type {
  DocumentClassifier,
  Logger,
  TextExtractor,
} from '../../src/application/ports/index.js';
import { IngestDocumentService } from '../../src/application/services/ingest-document.js';
import { ProcessDocumentService } from '../../src/application/services/process-document.js';
import {
  DocumentNotFoundError,
  ExternalServiceError,
  InvalidStatusTransitionError,
  UnsupportedFileTypeError,
} from '../../src/domain/errors.js';
import type { ClassificationResult } from '../../src/domain/processing.js';
import {
  InMemoryDocumentRepository,
  InMemoryDocumentStorage,
  KeywordDocumentClassifier,
} from '../../src/infrastructure/local-adapters.js';
import { pdfBytes, pngBytes } from '../support/fixtures.js';

const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const clock = { now: () => new Date('2026-01-01T00:00:00Z') };
let counter = 0;
const ids = { newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}` };

function setup(overrides: { extractor?: TextExtractor; classifier?: DocumentClassifier } = {}) {
  const repository = new InMemoryDocumentRepository();
  const storage = new InMemoryDocumentStorage();
  const ingest = new IngestDocumentService({
    repository,
    storage,
    clock,
    ids,
    logger,
    maxUploadBytes: 4096,
  });
  const extractor: TextExtractor = overrides.extractor ?? {
    extract: () =>
      Promise.resolve({ provider: 'fake', text: 'INVOICE #1', pageCount: 1, confidence: 0.9 }),
  };
  const process = new ProcessDocumentService({
    repository,
    extractor,
    classifier: overrides.classifier ?? new KeywordDocumentClassifier(),
    clock,
    logger,
  });
  const ingestPdf = () =>
    ingest.execute({ filename: 'a.pdf', declaredMimeType: 'application/pdf', content: pdfBytes() });
  return { repository, storage, ingest, process, ingestPdf };
}

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
      extractor: { extract: () => Promise.resolve(malformed) },
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
