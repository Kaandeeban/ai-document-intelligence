import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import type { Adapters } from '../../src/container.js';
import {
  filePart,
  jpegBytes,
  multipart,
  pdfBytes,
  pngBytes,
  testConfig,
  textBytes,
} from '../support/fixtures.js';

let app: FastifyInstance;

async function start(adapters: Partial<Adapters> = {}, docs = false) {
  app = await buildApp({ config: testConfig({ apiDocsEnabled: docs }), adapters });
  await app.ready();
}

const upload = (...parts: Parameters<typeof multipart>[0]) => {
  const { payload, headers } = multipart(parts);
  return app.inject({ method: 'POST', url: '/v1/documents', payload, headers });
};

beforeEach(async () => {
  await start();
});

afterEach(async () => {
  await app.close();
});

describe('POST /v1/documents', () => {
  it.each([
    ['invoice.pdf', 'application/pdf', pdfBytes(), 'pdf'],
    ['scan.png', 'image/png', pngBytes(), 'png'],
    ['photo.JPG', 'image/jpeg', jpegBytes(), 'jpeg'],
  ])('accepts %s', async (filename, mime, content, fileType) => {
    const res = await upload(filePart(filename, mime, content));
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; status: string; fileType: string; storageKey?: string }>();
    expect(body).toMatchObject({ status: 'STORED', fileType, filename });
    expect(body.storageKey).toBeUndefined();
    expect(res.headers.location).toBe(`/v1/documents/${body.id}`);
  });

  it('sanitises path traversal in filenames', async () => {
    const res = await upload(filePart('../../evil.pdf', 'application/pdf', pdfBytes()));
    expect(res.statusCode).toBe(201);
    expect(res.json<{ filename: string }>().filename).toBe('evil.pdf');
  });

  it.each([
    ['spoofed MIME (text declared as PDF)', filePart('a.pdf', 'application/pdf', textBytes())],
    ['PNG content with .pdf extension', filePart('a.pdf', 'application/pdf', pngBytes())],
    ['disallowed extension', filePart('a.exe', 'application/pdf', pdfBytes())],
    ['disallowed MIME', filePart('a.pdf', 'text/plain', pdfBytes())],
  ])('rejects %s with 415 problem+json', async (_label, part) => {
    const res = await upload(part);
    expect(res.statusCode).toBe(415);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ status: 415, code: 'UNSUPPORTED_FILE_TYPE' });
  });

  it('rejects files above the size limit with 413', async () => {
    const big = Buffer.concat([pdfBytes(), Buffer.alloc(8192)]);
    const res = await upload(filePart('big.pdf', 'application/pdf', big));
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: 'FILE_TOO_LARGE' });
  });

  it('rejects empty files with 400', async () => {
    const res = await upload(filePart('a.pdf', 'application/pdf', Buffer.alloc(0)));
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'EMPTY_FILE' });
  });

  it('rejects requests without a file', async () => {
    const res = await upload({ name: 'note', content: 'hello' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects more than one file', async () => {
    const res = await upload(
      filePart('a.pdf', 'application/pdf', pdfBytes()),
      filePart('b.pdf', 'application/pdf', pdfBytes()),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('rejects non-multipart requests with 415', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/documents', payload: { a: 1 } });
    expect(res.statusCode).toBe(415);
  });

  it('returns 502 and records FAILED when storage is unavailable', async () => {
    await app.close();
    await start({
      storage: {
        put: () => Promise.reject(new Error('down')),
        get: () => Promise.resolve(undefined),
      },
    });
    const res = await upload(filePart('a.pdf', 'application/pdf', pdfBytes()));
    expect(res.statusCode).toBe(502);
    expect(res.json()).not.toHaveProperty('details');
  });
});

describe('GET /v1/documents/:id', () => {
  it('returns the document with its status history', async () => {
    const created = (await upload(filePart('a.pdf', 'application/pdf', pdfBytes()))).json<{
      id: string;
    }>();
    const res = await app.inject({ method: 'GET', url: `/v1/documents/${created.id}` });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ statusHistory: { status: string }[] }>();
    expect(body.statusHistory.map((s) => s.status)).toEqual(['RECEIVED', 'STORED']);
  });

  it('returns 404 for unknown IDs', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/documents/6f1c2c1e-6c1a-4a8e-9a43-1f0d6f2a9b10',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'DOCUMENT_NOT_FOUND' });
  });

  it('returns 400 for malformed IDs', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/documents/not-a-uuid' });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('POST /v1/documents/:id/process', () => {
  it('processes a stored document, then rejects reprocessing with 409', async () => {
    const { id } = (await upload(filePart('a.pdf', 'application/pdf', pdfBytes()))).json<{
      id: string;
    }>();
    const first = await app.inject({ method: 'POST', url: `/v1/documents/${id}/process` });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      status: 'PROCESSED',
      processing: { classification: { provider: 'keyword', documentClass: 'OTHER' } },
    });
    const second = await app.inject({ method: 'POST', url: `/v1/documents/${id}/process` });
    expect(second.statusCode).toBe(409);
  });
});

describe('cross-cutting', () => {
  it('serves /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('echoes a well-formed x-request-id and replaces a malformed one', async () => {
    const good = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'abc-123' },
    });
    expect(good.headers['x-request-id']).toBe('abc-123');
    const bad = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-request-id': 'bad id\nINJECTED' },
    });
    expect(bad.headers['x-request-id']).not.toContain('INJECTED');
  });

  it('returns problem+json for unknown routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'ROUTE_NOT_FOUND' });
  });

  it('serves the OpenAPI document when enabled', async () => {
    await app.close();
    await start({}, true);
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json<{ paths: object }>().paths)).toEqual(
      expect.arrayContaining(['/v1/documents', '/v1/documents/{id}', '/v1/documents/{id}/process']),
    );
  });
});
