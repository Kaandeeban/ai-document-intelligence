import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { TextExtractor } from '../../src/application/ports/index.js';
import type { ApplicationOverrides } from '../../src/container.js';
import type { ExtractionCheck } from '../../src/domain/processing.js';
import { filePart, multipart, pdfBytes, pngBytes, testConfig } from '../support/fixtures.js';
import { ocrResult } from '../support/services.js';

/**
 * Exercises the real HTTP API, services, in-memory adapters and in-process
 * scheduler, with a fake OCR adapter that is synchronous for images and
 * asynchronous for PDFs (same split as Textract). No AWS involved.
 */
function hybridExtractor(checks: ExtractionCheck[]) {
  const start = vi.fn<TextExtractor['start']>((request) =>
    Promise.resolve(
      request.fileType === 'pdf'
        ? { status: 'IN_PROGRESS', provider: 'fake-ocr', jobId: `job-${request.attempt}` }
        : { status: 'COMPLETED', result: ocrResult() },
    ),
  );
  const check = vi.fn<TextExtractor['check']>(() =>
    Promise.resolve(checks.shift() ?? { status: 'IN_PROGRESS' }),
  );
  return {
    isAsynchronous: (fileType: string) => fileType === 'pdf',
    start,
    check,
  } satisfies TextExtractor;
}

let app: FastifyInstance;

async function start(
  extractor: TextExtractor,
  extraction: Partial<ReturnType<typeof testConfig>['extraction']> = {},
  overrides: ApplicationOverrides = {},
) {
  const base = testConfig();
  app = await buildApp({
    config: { ...base, extraction: { ...base.extraction, ...extraction } },
    adapters: { extractor, ...overrides },
  });
  await app.ready();
}

async function uploadAndProcess(filename: string, mime: string, content: Buffer) {
  const { payload, headers } = multipart([filePart(filename, mime, content)]);
  const upload = await app.inject({ method: 'POST', url: '/v1/documents', payload, headers });
  const { id } = upload.json<{ id: string }>();
  const res = await app.inject({ method: 'POST', url: `/v1/documents/${id}/process` });
  return { id, res };
}

const getDocument = async (id: string) =>
  (await app.inject({ method: 'GET', url: `/v1/documents/${id}` })).json<{
    status: string;
    processingAttempts: number;
    statusHistory: { status: string; reason?: string }[];
  }>();

afterEach(async () => {
  await app.close();
});

describe('asynchronous PDF OCR over HTTP', () => {
  it('returns 202 EXTRACTING immediately, then completes in the background', async () => {
    const extractor = hybridExtractor([
      { status: 'IN_PROGRESS' },
      { status: 'COMPLETED', result: ocrResult() },
    ]);
    await start(extractor);
    const { id, res } = await uploadAndProcess('a.pdf', 'application/pdf', pdfBytes());

    expect(res.statusCode).toBe(202);
    expect(res.headers.location).toBe(`/v1/documents/${id}`);
    expect(res.json()).toMatchObject({ status: 'EXTRACTING', processingAttempts: 1 });
    expect(res.json()).not.toHaveProperty('extractionJob');

    await vi.waitFor(async () => {
      expect((await getDocument(id)).status).toBe('PROCESSED');
    });
    const doc = await getDocument(id);
    expect(doc.statusHistory.map((s) => s.status)).toEqual([
      'RECEIVED',
      'STORED',
      'PROCESSING',
      'EXTRACTING',
      'PROCESSING',
      'PROCESSED',
    ]);
    expect(extractor.check).toHaveBeenCalledTimes(2);
  });

  it('keeps 200 PROCESSED for images', async () => {
    await start(hybridExtractor([]));
    const { res } = await uploadAndProcess('a.png', 'image/png', pngBytes());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'PROCESSED' });
  });

  it('rejects duplicate submissions with 409 and starts only one job', async () => {
    const extractor = hybridExtractor([]);
    await start(extractor);
    const { id, res } = await uploadAndProcess('a.pdf', 'application/pdf', pdfBytes());
    expect(res.statusCode).toBe(202);
    const again = await app.inject({ method: 'POST', url: `/v1/documents/${id}/process` });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'INVALID_STATUS_TRANSITION' });
    expect(extractor.start).toHaveBeenCalledTimes(1);
  });

  it('records FAILED with a sanitised reason when the job fails, and allows retry', async () => {
    const extractor = hybridExtractor([{ status: 'FAILED', reason: 'PARTIAL_SUCCESS' }]);
    await start(extractor);
    const { id } = await uploadAndProcess('a.pdf', 'application/pdf', pdfBytes());

    await vi.waitFor(async () => {
      expect((await getDocument(id)).status).toBe('FAILED');
    });
    expect((await getDocument(id)).statusHistory.at(-1)?.reason).toBe(
      'Text extraction only partially succeeded',
    );

    const retry = await app.inject({ method: 'POST', url: `/v1/documents/${id}/process` });
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toMatchObject({ processingAttempts: 2 });
  });

  it('times out a job that never finishes', async () => {
    await start(hybridExtractor([]), { jobTimeoutMs: 60, pollMaxDelayMs: 10 });
    const { id } = await uploadAndProcess('a.pdf', 'application/pdf', pdfBytes());
    await vi.waitFor(async () => {
      expect((await getDocument(id)).status).toBe('FAILED');
    });
    expect((await getDocument(id)).statusHistory.at(-1)?.reason).toBe('Text extraction timed out');
  });

  it('returns 503 with Retry-After when asynchronous capacity is exhausted', async () => {
    const extractor = hybridExtractor([]);
    await start(extractor, {
      maxPendingJobs: 1,
      jobTimeoutMs: 60_000,
      pollInitialDelayMs: 50_000,
      pollMaxDelayMs: 50_000,
    });
    const first = await uploadAndProcess('a.pdf', 'application/pdf', pdfBytes());
    expect(first.res.statusCode).toBe(202);

    const second = await uploadAndProcess('b.pdf', 'application/pdf', pdfBytes());
    expect(second.res.statusCode).toBe(503);
    expect(second.res.headers['retry-after']).toBe('30');
    expect((await getDocument(second.id)).status).toBe('STORED');
    expect(extractor.start).toHaveBeenCalledTimes(1);
  });
});
