import { describe, expect, it, vi } from 'vitest';
import type { TextExtractor } from '../../src/application/ports/index.js';
import {
  ConcurrentModificationError,
  ExternalServiceError,
  InvalidStatusTransitionError,
  ServiceUnavailableError,
} from '../../src/domain/errors.js';
import {
  extractionArtifactKey,
  extractionArtifactSchema,
} from '../../src/domain/extraction-artifact.js';
import type { ExtractionCheck, ExtractionStart } from '../../src/domain/processing.js';
import { DEFAULT_POLICY, createTestServices, ocrResult } from '../support/services.js';

/** Fake async OCR: start returns a job; check returns queued results in order. */
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
  return { isAsynchronous: () => true, start, check } satisfies TextExtractor;
}

const transient = () =>
  new ExternalServiceError('textract GetDocumentTextDetection failed', { retryable: true });
const permanent = () =>
  new ExternalServiceError('textract GetDocumentTextDetection failed', { retryable: false });

async function startedPdf(...checks: (ExtractionCheck | Error)[]) {
  const extractor = asyncExtractor(...checks);
  const ctx = createTestServices({ extractor });
  const { id } = await ctx.ingestPdf();
  const extracting = await ctx.process.execute(id);
  return { ...ctx, extractor, id, extracting };
}

const readArtifact = async (
  storage: { get(key: string): Promise<Uint8Array | undefined> },
  id: string,
) => {
  const bytes = await storage.get(extractionArtifactKey(id));
  return extractionArtifactSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
};

describe('ProcessDocumentService — asynchronous start', () => {
  it('records the job, returns EXTRACTING and schedules a check without waiting', async () => {
    const { extracting, scheduler, extractor, id } = await startedPdf();
    expect(extracting.status).toBe('EXTRACTING');
    expect(extracting.processingAttempts).toBe(1);
    expect(extracting.extractionJob).toMatchObject({ jobId: `job-${id}-1`, checks: 0 });
    expect(extractor.check).not.toHaveBeenCalled();
    expect(scheduler.scheduled).toEqual([
      { documentId: id, delayMs: DEFAULT_POLICY.initialDelayMs, reserved: true },
    ]);
  });

  it('rejects a second submission while EXTRACTING (409 path)', async () => {
    const { process, extractor, id } = await startedPdf();
    await expect(process.execute(id)).rejects.toThrow(InvalidStatusTransitionError);
    expect(extractor.start).toHaveBeenCalledTimes(1);
  });

  it('lets only one of two concurrent submissions start a job', async () => {
    const extractor = asyncExtractor();
    const { ingestPdf, process } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    const results = await Promise.allSettled([process.execute(id), process.execute(id)]);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ConcurrentModificationError);
    expect(extractor.start).toHaveBeenCalledTimes(1);
  });

  it('refuses new work without starting a job when capacity is exhausted', async () => {
    const extractor = asyncExtractor();
    const { ingestPdf, process, scheduler, repository } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    scheduler.capacity = false;
    await expect(process.execute(id)).rejects.toThrow(ServiceUnavailableError);
    expect(extractor.start).not.toHaveBeenCalled();
    expect((await repository.findById(id))?.status).toBe('STORED');
  });

  it('marks the document FAILED when the job cannot be started', async () => {
    const extractor = asyncExtractor();
    extractor.start.mockRejectedValueOnce(permanent());
    const { ingestPdf, process, repository, scheduler } = createTestServices({ extractor });
    const { id } = await ingestPdf();
    await expect(process.execute(id)).rejects.toThrow('Text extraction failed');
    expect((await repository.findById(id))?.status).toBe('FAILED');
    expect(scheduler.scheduled).toHaveLength(0);
  });
});

describe('CompleteExtractionService', () => {
  it('stays pending with exponential, capped backoff and counts checks', async () => {
    const { complete, repository, clock, id } = await startedPdf();
    const delays: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      clock.advance(1_000);
      const outcome = await complete.execute(id);
      expect(outcome.state).toBe('PENDING');
      if (outcome.state === 'PENDING') delays.push(outcome.nextCheckInMs);
    }
    expect(delays).toEqual([2_000, 4_000, 8_000, 8_000, 8_000]);
    const stored = await repository.findById(id);
    expect(stored?.status).toBe('EXTRACTING');
    expect(stored?.extractionJob?.checks).toBe(5);
  });

  it('never schedules a check beyond the job deadline', async () => {
    const { complete, clock, id } = await startedPdf();
    clock.advance(DEFAULT_POLICY.jobTimeoutMs - 500);
    expect(await complete.execute(id)).toEqual({ state: 'PENDING', nextCheckInMs: 500 });
  });

  it('completes: persists a valid artifact, classifies and marks PROCESSED', async () => {
    const result = ocrResult({
      pageCount: 2,
      engineVersion: '1.0',
      lines: [
        { page: 1, text: 'INVOICE #1', confidence: 0.95 },
        { page: 2, text: 'Total', confidence: null },
      ],
      text: 'INVOICE #1\nTotal',
      warnings: ['MISSING_CONFIDENCE'],
    });
    const { complete, repository, storage, id } = await startedPdf({ status: 'COMPLETED', result });
    expect(await complete.execute(id)).toEqual({ state: 'COMPLETED' });

    const doc = await repository.findById(id);
    expect(doc?.status).toBe('PROCESSED');
    expect(doc?.statusHistory.map((s) => s.status)).toEqual([
      'RECEIVED',
      'STORED',
      'PROCESSING',
      'EXTRACTING',
      'PROCESSING',
      'PROCESSED',
    ]);
    expect(doc?.processing?.classification.documentClass).toBe('INVOICE');

    const artifact = await readArtifact(storage, id);
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      documentId: id,
      attempt: 1,
      engine: { provider: 'fake-ocr', version: '1.0' },
      pageCount: 2,
      text: 'INVOICE #1\nTotal',
      warnings: ['MISSING_CONFIDENCE'],
      pages: [
        { pageNumber: 1, lineCount: 1, confidence: 0.95 },
        { pageNumber: 2, lineCount: 1, confidence: null },
      ],
    });
  });

  it.each([
    ['JOB_FAILED', 'Text extraction job failed'],
    ['PARTIAL_SUCCESS', 'Text extraction only partially succeeded'],
  ] as const)('marks %s jobs FAILED with a sanitised reason', async (reason, message) => {
    const { complete, repository, id } = await startedPdf({ status: 'FAILED', reason });
    expect(await complete.execute(id)).toEqual({ state: 'FAILED' });
    const doc = await repository.findById(id);
    expect(doc?.status).toBe('FAILED');
    expect(doc?.statusHistory.at(-1)?.reason).toBe(message);
  });

  it('times out a job that is still running after the deadline', async () => {
    const { complete, repository, clock, id } = await startedPdf();
    clock.advance(DEFAULT_POLICY.jobTimeoutMs);
    expect(await complete.execute(id)).toEqual({ state: 'FAILED' });
    expect((await repository.findById(id))?.statusHistory.at(-1)?.reason).toBe(
      'Text extraction timed out',
    );
  });

  it('keeps checking after a transient error before the deadline', async () => {
    const { complete, repository, id } = await startedPdf(transient());
    expect((await complete.execute(id)).state).toBe('PENDING');
    expect((await repository.findById(id))?.status).toBe('EXTRACTING');
  });

  it('fails on a transient error once the deadline has passed', async () => {
    const { complete, repository, clock, id } = await startedPdf(transient());
    clock.advance(DEFAULT_POLICY.jobTimeoutMs);
    expect((await complete.execute(id)).state).toBe('FAILED');
    expect((await repository.findById(id))?.status).toBe('FAILED');
  });

  it('fails immediately on a permanent error', async () => {
    const { complete, repository, id } = await startedPdf(permanent());
    expect((await complete.execute(id)).state).toBe('FAILED');
    expect((await repository.findById(id))?.statusHistory.at(-1)?.reason).toBe(
      'Text extraction status check failed',
    );
  });

  it('fails when the extractor returns a malformed check result', async () => {
    const malformed = {
      status: 'COMPLETED',
      result: { provider: '' },
    } as unknown as ExtractionCheck;
    const { complete, repository, id } = await startedPdf(malformed);
    expect((await complete.execute(id)).state).toBe('FAILED');
    expect((await repository.findById(id))?.statusHistory.at(-1)?.reason).toBe(
      'Text extraction status check returned an invalid response',
    );
  });

  it('ignores documents that are not EXTRACTING (duplicate or stale triggers)', async () => {
    const { complete, extractor, id } = await startedPdf({
      status: 'COMPLETED',
      result: ocrResult(),
    });
    expect((await complete.execute(id)).state).toBe('COMPLETED');
    expect(await complete.execute(id)).toEqual({ state: 'IGNORED' });
    expect(await complete.execute('00000000-0000-4000-8000-ffffffffffff')).toEqual({
      state: 'IGNORED',
    });
    expect(extractor.check).toHaveBeenCalledTimes(1);
  });

  it('allows a retry after failure, submitting a new attempt', async () => {
    const { complete, process, extractor, id } = await startedPdf({
      status: 'FAILED',
      reason: 'JOB_FAILED',
    });
    await complete.execute(id);
    const retried = await process.execute(id);
    expect(retried.status).toBe('EXTRACTING');
    expect(retried.processingAttempts).toBe(2);
    expect(extractor.start).toHaveBeenLastCalledWith(expect.objectContaining({ attempt: 2 }));
  });
});

describe('synchronous path', () => {
  it('persists the extraction artifact for synchronous OCR as well', async () => {
    const { ingestPng, process, storage } = createTestServices();
    const { id } = await ingestPng();
    const doc = await process.execute(id);
    expect(doc.status).toBe('PROCESSED');
    expect((await readArtifact(storage, id)).lines).toHaveLength(1);
  });
});
