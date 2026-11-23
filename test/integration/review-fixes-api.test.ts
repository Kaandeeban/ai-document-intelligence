import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { TextExtractor } from '../../src/application/ports/index.js';
import type { AppConfig } from '../../src/config/env.js';
import type { ApplicationOverrides } from '../../src/container.js';
import { TEXTRACT_SYNC_MAX_BYTES } from '../../src/infrastructure/aws/textract-text-extractor.js';
import { InMemoryDocumentStorage } from '../../src/infrastructure/local-adapters.js';
import { filePart, multipart, pdfBytes, pngBytes, testConfig } from '../support/fixtures.js';
import { ocrResult } from '../support/services.js';

const hybridExtractor = () => {
  const start = vi.fn<TextExtractor['start']>((request) =>
    Promise.resolve(
      request.fileType === 'pdf'
        ? { status: 'IN_PROGRESS', provider: 'fake-ocr', jobId: `job-${request.documentId}` }
        : { status: 'COMPLETED', result: ocrResult() },
    ),
  );
  const check = vi.fn<TextExtractor['check']>(() => Promise.resolve({ status: 'IN_PROGRESS' }));
  return {
    isAsynchronous: (t: string) => t === 'pdf',
    start,
    check,
  } satisfies TextExtractor;
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(config: AppConfig, adapters: ApplicationOverrides) {
  app = await buildApp({ config, adapters });
  await app.ready();
  return app;
}

async function upload(instance: FastifyInstance, filename: string, mime: string, content: Buffer) {
  const { payload, headers } = multipart([filePart(filename, mime, content)]);
  return instance.inject({ method: 'POST', url: '/v1/documents', payload, headers });
}

const padded = (head: Buffer, size: number) =>
  Buffer.concat([head, Buffer.alloc(size - head.length)]);

describe('M1 — concurrent PDF submissions cannot exceed async capacity', () => {
  it('admits exactly maxPendingJobs of N concurrent requests and submits only those', async () => {
    const extractor = hybridExtractor();
    const base = testConfig();
    const instance = await start(
      {
        ...base,
        extraction: {
          ...base.extraction,
          maxPendingJobs: 2,
          pollInitialDelayMs: 60_000,
          pollMaxDelayMs: 60_000,
          jobTimeoutMs: 600_000,
        },
      },
      { extractor },
    );
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      ids.push(
        (await upload(instance, `${i}.pdf`, 'application/pdf', pdfBytes())).json<{ id: string }>()
          .id,
      );
    }
    const responses = await Promise.all(
      ids.map((id) => instance.inject({ method: 'POST', url: `/v1/documents/${id}/process` })),
    );
    const codes = responses.map((r) => r.statusCode).sort();
    expect(codes).toEqual([202, 202, 503, 503, 503, 503]);
    expect(extractor.start).toHaveBeenCalledTimes(2);
  });
});

describe('M4 — Textract synchronous image limit enforced at upload', () => {
  const textractConfig = (): AppConfig => {
    const base = testConfig();
    return {
      ...base,
      maxUploadBytes: TEXTRACT_SYNC_MAX_BYTES * 2,
      storage: { driver: 's3', bucket: 'example-invoice-bucket' },
      extraction: { ...base.extraction, driver: 'textract' },
      aws: { ...base.aws, region: 'eu-west-2' },
    };
  };
  // Explicit storage/extractor overrides: no AWS clients are created.
  const localAdapters = () => ({
    storage: new InMemoryDocumentStorage(),
    extractor: hybridExtractor(),
  });

  it('accepts an image of exactly the limit', async () => {
    const instance = await start(textractConfig(), localAdapters());
    const res = await upload(
      instance,
      'a.png',
      'image/png',
      padded(pngBytes(), TEXTRACT_SYNC_MAX_BYTES),
    );
    expect(res.statusCode).toBe(201);
  });

  it('rejects an image one byte over the limit with 413', async () => {
    const instance = await start(textractConfig(), localAdapters());
    const res = await upload(
      instance,
      'a.png',
      'image/png',
      padded(pngBytes(), TEXTRACT_SYNC_MAX_BYTES + 1),
    );
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({
      code: 'FILE_TOO_LARGE',
      details: { maxBytes: TEXTRACT_SYNC_MAX_BYTES, fileType: 'png' },
    });
  });

  it('accepts a PDF over the image limit (asynchronous API)', async () => {
    const instance = await start(textractConfig(), localAdapters());
    const res = await upload(
      instance,
      'a.pdf',
      'application/pdf',
      padded(pdfBytes(), TEXTRACT_SYNC_MAX_BYTES + 1),
    );
    expect(res.statusCode).toBe(201);
  });

  it('does not apply the image limit with the local stub extractor', async () => {
    const base = testConfig();
    const instance = await start({ ...base, maxUploadBytes: TEXTRACT_SYNC_MAX_BYTES * 2 }, {});
    const res = await upload(
      instance,
      'a.png',
      'image/png',
      padded(pngBytes(), TEXTRACT_SYNC_MAX_BYTES + 1),
    );
    expect(res.statusCode).toBe(201);
  });
});

describe('L1 — shutdown waits for the scheduler before resolving', () => {
  it('app.close() awaits the scheduler shutdown', async () => {
    let releaseClose: () => void = () => undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseClose = resolve;
        }),
    );
    const instance = await start(testConfig(), {
      schedulerFactory: () => ({ reserve: () => undefined, schedule: vi.fn(), close }),
    });
    let closed = false;
    const closing = instance.close().then(() => {
      closed = true;
    });
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledTimes(1);
    });
    expect(closed).toBe(false);
    releaseClose();
    await closing;
    expect(closed).toBe(true);
    app = undefined;
  });
});
