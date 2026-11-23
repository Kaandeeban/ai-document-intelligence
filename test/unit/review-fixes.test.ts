/**
 * Regression tests for the Milestone 2 review findings
 * (H1, M1, M2, M3, M4, L1, L2, L3, L4, L5, L8). AWS-specific cases live in
 * test/unit/aws/*; HTTP-level cases in test/integration/review-fixes-api.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import type { TextExtractor } from '../../src/application/ports/index.js';
import { recordProcessingFailure } from '../../src/application/services/processing-support.js';
import type { DocumentRecord } from '../../src/domain/document.js';
import {
  ConcurrentModificationError,
  ExternalServiceError,
  FileTooLargeError,
  InvalidStatusTransitionError,
  ServiceUnavailableError,
} from '../../src/domain/errors.js';
import { validateUpload } from '../../src/domain/upload-policy.js';
import type { ExtractionCheck, ExtractionStart } from '../../src/domain/processing.js';
import {
  TEXTRACT_SYNC_IMAGE_LIMITS,
  TEXTRACT_SYNC_MAX_BYTES,
} from '../../src/infrastructure/aws/textract-text-extractor.js';
import { jpegBytes, pdfBytes, pngBytes } from '../support/fixtures.js';
import { createTestServices, ocrResult, syncExtractor } from '../support/services.js';

function asyncExtractor(...checks: (ExtractionCheck | Error)[]) {
  const start = vi.fn<TextExtractor['start']>((request) =>
    Promise.resolve<ExtractionStart>({
      status: 'IN_PROGRESS',
      provider: 'fake-ocr',
      jobId: `job-${request.documentId}-${request.attempt}`,
    }),
  );
  const check = vi.fn<TextExtractor['check']>(() => {
    const next = checks.shift() ?? { status: 'IN_PROGRESS' };
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  });
  return { isAsynchronous: (t: string) => t === 'pdf', start, check } satisfies TextExtractor;
}

describe('M1/L4 — capacity reservation', () => {
  it('reserves before submission and hands the slot to the scheduler', async () => {
    const { ingestPdf, process, scheduler } = createTestServices({ extractor: asyncExtractor() });
    const { id } = await ingestPdf();
    await process.execute(id);
    expect(scheduler.reservations).toBe(1);
    expect(scheduler.scheduled[0]?.reserved).toBe(true);
    expect(scheduler.outstanding.size).toBe(0);
  });

  it('releases the reservation when submission fails', async () => {
    const extractor = asyncExtractor();
    extractor.start.mockRejectedValueOnce(new Error('boom'));
    const { ingestPdf, process, scheduler } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    await expect(process.execute(id)).rejects.toThrow();
    expect(scheduler.reservations).toBe(1);
    expect(scheduler.outstanding.size).toBe(0);
  });

  it('releases the loser’s reservation in a concurrent race for the same document', async () => {
    const extractor = asyncExtractor();
    const { ingestPdf, process, scheduler } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    const results = await Promise.allSettled([process.execute(id), process.execute(id)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ConcurrentModificationError);
    expect(extractor.start).toHaveBeenCalledTimes(1);
    expect(scheduler.outstanding.size).toBe(0);
  });

  it('never reserves for images and is not blocked when async capacity is full', async () => {
    const extractor = { ...syncExtractor(), isAsynchronous: (t: string) => t === 'pdf' };
    const { ingestPng, ingestPdf, process, scheduler } = createTestServices({ extractor });
    scheduler.capacity = false;
    const png = await ingestPng();
    expect((await process.execute(png.id)).status).toBe('PROCESSED');
    expect(scheduler.reservations).toBe(0);

    const pdf = await ingestPdf();
    await expect(process.execute(pdf.id)).rejects.toThrow(ServiceUnavailableError);
  });
});

describe('M3 — submitted job that cannot be tracked', () => {
  it('logs the job ID and keeps it on the FAILED record', async () => {
    const extractor = asyncExtractor();
    const { ingestPdf, process, repository, logWarn, scheduler } = createTestServices({
      extractor,
    });
    const { id } = await ingestPdf();
    const realSave = repository.save.bind(repository);
    vi.spyOn(repository, 'save').mockImplementation((doc: DocumentRecord) =>
      doc.status === 'EXTRACTING'
        ? Promise.reject(new Error('database unavailable'))
        : realSave(doc),
    );

    await expect(process.execute(id)).rejects.toThrow();
    const stored = await repository.findById(id);
    expect(stored?.status).toBe('FAILED');
    expect(stored?.statusHistory.at(-1)?.reason).toBe('Text extraction job could not be tracked');
    expect(stored?.extractionJob?.jobId).toBe(`job-${id}-1`);
    expect(logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: id, jobId: `job-${id}-1` }),
      expect.stringContaining('could not be tracked'),
    );
    expect(scheduler.scheduled).toHaveLength(0);
    expect(scheduler.outstanding.size).toBe(0);
  });
});

describe('L2 — failure-state persistence errors', () => {
  it('reports the original error and logs a stuck document when FAILED cannot be saved', async () => {
    const extractor = asyncExtractor();
    extractor.start.mockRejectedValueOnce(
      new ExternalServiceError('textract StartDocumentTextDetection failed', { retryable: false }),
    );
    const { ingestPdf, process, repository, logError } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    const realSave = repository.save.bind(repository);
    vi.spyOn(repository, 'save').mockImplementation((doc: DocumentRecord) =>
      doc.status === 'FAILED' ? Promise.reject(new Error('database unavailable')) : realSave(doc),
    );

    await expect(process.execute(id)).rejects.toThrow('Text extraction failed');
    expect((await repository.findById(id))?.status).toBe('PROCESSING');
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: id, stuck: true }),
      expect.stringContaining('may be stuck'),
    );
  });

  it('completion still reports FAILED and logs when FAILED cannot be saved', async () => {
    const { ingestPdf, process, complete, repository, logError } = createTestServices({
      extractor: asyncExtractor({ status: 'FAILED', reason: 'JOB_FAILED' }),
    });
    const { id } = await ingestPdf();
    await process.execute(id);
    const realSave = repository.save.bind(repository);
    vi.spyOn(repository, 'save').mockImplementation((doc: DocumentRecord) =>
      doc.status === 'FAILED' ? Promise.reject(new Error('database unavailable')) : realSave(doc),
    );
    expect(await complete.execute(id)).toEqual({ state: 'FAILED' });
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ stuck: true }),
      expect.any(String),
    );
  });

  it('recordProcessingFailure never throws, even if the lookup fails', async () => {
    const { repository, clock, logger } = createTestServices();
    vi.spyOn(repository, 'findById').mockRejectedValueOnce(new Error('down'));
    await expect(
      recordProcessingFailure({ repository, clock, logger }, 'x', new Error('original')),
    ).resolves.toBeUndefined();
  });
});

describe('L3 — documents that never reached STORED', () => {
  it('refuses to process a document whose upload failed', async () => {
    const { ingest, process, storage, repository } = createTestServices();
    vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('s3 down'));
    const error = (await ingest
      .execute({ filename: 'a.pdf', declaredMimeType: 'application/pdf', content: pdfBytes() })
      .catch((e: unknown) => e)) as ExternalServiceError;
    const id = error.details?.documentId as string;
    expect((await repository.findById(id))?.status).toBe('FAILED');
    await expect(process.execute(id)).rejects.toThrow(
      'Document was never stored and cannot be processed',
    );
  });

  it('still allows retrying a stored document after a general failure', async () => {
    const extractor = asyncExtractor({ status: 'FAILED', reason: 'JOB_FAILED' });
    const { ingestPdf, process, complete } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    await process.execute(id);
    await complete.execute(id);
    expect((await process.execute(id)).status).toBe('EXTRACTING');
  });
});

describe('L5 — deterministic result-limit failures', () => {
  const limitError = () =>
    new ExternalServiceError('textract result exceeds the configured page limit', {
      retryable: false,
      failureCode: 'RESULT_LIMIT_EXCEEDED',
    });

  it('fails with a specific reason and refuses further billable submissions', async () => {
    const extractor = asyncExtractor(limitError());
    const { ingestPdf, process, complete, repository } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    await process.execute(id);
    expect(await complete.execute(id)).toEqual({ state: 'FAILED' });

    const doc = await repository.findById(id);
    expect(doc?.statusHistory.at(-1)?.reason).toBe(
      'Text extraction result exceeds the configured page limit',
    );
    expect(doc?.lastFailure?.code).toBe('RESULT_LIMIT_EXCEEDED');
    await expect(process.execute(id)).rejects.toThrow(InvalidStatusTransitionError);
    expect(extractor.start).toHaveBeenCalledTimes(1);
  });

  it('is not treated as transient even before the job deadline', async () => {
    const extractor = asyncExtractor(limitError());
    const { ingestPdf, process, complete } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    await process.execute(id);
    expect((await complete.execute(id)).state).toBe('FAILED');
    expect(extractor.check).toHaveBeenCalledTimes(1);
  });

  it('clears the previous general failure when a retry succeeds', async () => {
    const extractor = asyncExtractor(
      { status: 'FAILED', reason: 'JOB_FAILED' },
      { status: 'COMPLETED', result: ocrResult() },
    );
    const { ingestPdf, process, complete, repository } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    await process.execute(id);
    await complete.execute(id);
    await process.execute(id);
    await complete.execute(id);
    const doc = await repository.findById(id);
    expect(doc?.status).toBe('PROCESSED');
    expect(doc?.lastFailure).toBeUndefined();
  });
});

describe('M4 — Textract synchronous image size limit (domain boundary)', () => {
  const LIMIT = TEXTRACT_SYNC_IMAGE_LIMITS.png;
  const padded = (head: Buffer, size: number) =>
    Buffer.concat([head, Buffer.alloc(size - head.length)]);

  it.each([
    ['png', 'x.png', 'image/png', pngBytes()],
    ['jpeg', 'x.jpg', 'image/jpeg', jpegBytes()],
  ])('accepts a %s of exactly the limit and rejects one byte more', (_t, filename, mime, head) => {
    const max = LIMIT * 2;
    expect(
      validateUpload(
        { filename, declaredMimeType: mime, content: padded(head, LIMIT) },
        max,
        TEXTRACT_SYNC_IMAGE_LIMITS,
      ),
    ).toBeDefined();
    expect(() =>
      validateUpload(
        { filename, declaredMimeType: mime, content: padded(head, LIMIT + 1) },
        max,
        TEXTRACT_SYNC_IMAGE_LIMITS,
      ),
    ).toThrow(FileTooLargeError);
  });

  it('does not apply the image limit to PDFs', () => {
    expect(
      validateUpload(
        {
          filename: 'x.pdf',
          declaredMimeType: 'application/pdf',
          content: padded(pdfBytes(), LIMIT + 1),
        },
        LIMIT * 2,
        TEXTRACT_SYNC_IMAGE_LIMITS,
      ),
    ).toBe('pdf');
  });
});

describe('M4 — conservative decimal interpretation of the 10 MB limit', () => {
  it('pins the limit to 10,000,000 bytes', () => {
    expect(TEXTRACT_SYNC_MAX_BYTES).toBe(10_000_000);
    expect(TEXTRACT_SYNC_IMAGE_LIMITS).toEqual({ png: 10_000_000, jpeg: 10_000_000 });
  });

  it.each([
    [10_000_000, true],
    [10_000_001, false],
    [10 * 1024 * 1024, false], // 10 MiB is no longer accepted
  ])('PNG of %i bytes accepted: %s', (size, accepted) => {
    const candidate = {
      filename: 'x.png',
      declaredMimeType: 'image/png',
      content: Buffer.concat([pngBytes(), Buffer.alloc(size - pngBytes().length)]),
    };
    const run = () => validateUpload(candidate, 50 * 1024 * 1024, TEXTRACT_SYNC_IMAGE_LIMITS);
    if (accepted) expect(run()).toBe('png');
    else expect(run).toThrow(FileTooLargeError);
  });
});
