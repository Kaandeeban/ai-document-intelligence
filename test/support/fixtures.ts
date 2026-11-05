/** Synthetic, minimal file fixtures. No real documents are used. */
import type { AppConfig } from '../../src/config/env.js';

export const pdfBytes = (): Buffer =>
  Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << >>\n%%EOF\n', 'latin1');

export const pngBytes = (): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

export const jpegBytes = (): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(32),
    Buffer.from([0xff, 0xd9]),
  ]);

export const textBytes = (): Buffer => Buffer.from('just some plain text, not a document');

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 0,
    logLevel: 'silent',
    maxUploadBytes: 4096,
    requestTimeoutMs: 5000,
    apiDocsEnabled: false,
    ...overrides,
  };
}

export interface MultipartPart {
  name: string;
  content: Buffer | string;
  filename?: string;
  contentType?: string;
}

/** Builds a multipart/form-data body for Fastify's inject(). */
export function multipart(parts: MultipartPart[]): {
  payload: Buffer;
  headers: Record<string, string>;
} {
  const boundary = `----test-boundary-${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const part of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename !== undefined) header += `; filename="${part.filename}"`;
    header += '\r\n';
    if (part.contentType !== undefined) header += `Content-Type: ${part.contentType}\r\n`;
    chunks.push(Buffer.from(`${header}\r\n`), Buffer.from(part.content), Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export const filePart = (
  filename: string,
  contentType: string,
  content: Buffer,
): MultipartPart => ({
  name: 'file',
  filename,
  contentType,
  content,
});
