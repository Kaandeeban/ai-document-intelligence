import { describe, expect, it } from 'vitest';
import {
  EmptyFileError,
  FileTooLargeError,
  UnsupportedFileTypeError,
} from '../../src/domain/errors.js';
import {
  detectFileType,
  fileTypeFromExtension,
  fileTypeFromMimeType,
} from '../../src/domain/file-type.js';
import { sanitizeFilename, validateUpload } from '../../src/domain/upload-policy.js';
import { jpegBytes, pdfBytes, pngBytes, textBytes } from '../support/fixtures.js';

describe('detectFileType', () => {
  it.each([
    ['pdf', pdfBytes()],
    ['png', pngBytes()],
    ['jpeg', jpegBytes()],
  ])('detects %s from its signature', (type, bytes) => {
    expect(detectFileType(bytes)).toBe(type);
  });

  it('returns undefined for unknown, empty or truncated content', () => {
    expect(detectFileType(textBytes())).toBeUndefined();
    expect(detectFileType(new Uint8Array())).toBeUndefined();
    expect(detectFileType(Buffer.from([0x89, 0x50]))).toBeUndefined();
  });

  it('rejects a PDF signature that is not at offset 0', () => {
    expect(detectFileType(Buffer.concat([Buffer.from('junk'), pdfBytes()]))).toBeUndefined();
  });
});

describe('fileTypeFromExtension / fileTypeFromMimeType', () => {
  it('maps extensions case-insensitively', () => {
    expect(fileTypeFromExtension('a.PDF')).toBe('pdf');
    expect(fileTypeFromExtension('a.jpg')).toBe('jpeg');
    expect(fileTypeFromExtension('a.JPEG')).toBe('jpeg');
    expect(fileTypeFromExtension('a.pdf.exe')).toBeUndefined();
    expect(fileTypeFromExtension('noextension')).toBeUndefined();
  });

  it('ignores MIME parameters and case', () => {
    expect(fileTypeFromMimeType('Application/PDF; charset=binary')).toBe('pdf');
    expect(fileTypeFromMimeType('image/gif')).toBeUndefined();
  });
});

describe('validateUpload', () => {
  const max = 1024;

  it('accepts matching extension, MIME type and content', () => {
    expect(
      validateUpload(
        { filename: 'x.pdf', declaredMimeType: 'application/pdf', content: pdfBytes() },
        max,
      ),
    ).toBe('pdf');
  });

  it('rejects empty files', () => {
    expect(() =>
      validateUpload(
        { filename: 'x.pdf', declaredMimeType: 'application/pdf', content: Buffer.alloc(0) },
        max,
      ),
    ).toThrow(EmptyFileError);
  });

  it('rejects oversized files', () => {
    const content = Buffer.concat([pdfBytes(), Buffer.alloc(max)]);
    expect(() =>
      validateUpload({ filename: 'x.pdf', declaredMimeType: 'application/pdf', content }, max),
    ).toThrow(FileTooLargeError);
  });

  it.each([
    ['disallowed extension', 'x.exe', 'application/pdf', pdfBytes()],
    ['disallowed MIME type', 'x.pdf', 'application/octet-stream', pdfBytes()],
    ['unrecognised content', 'x.pdf', 'application/pdf', textBytes()],
    ['spoofed extension (PNG content as .pdf)', 'x.pdf', 'application/pdf', pngBytes()],
    ['MIME mismatch', 'x.png', 'image/jpeg', pngBytes()],
  ])('rejects %s', (_label, filename, declaredMimeType, content) => {
    expect(() => validateUpload({ filename, declaredMimeType, content }, max)).toThrow(
      UnsupportedFileTypeError,
    );
  });
});

describe('sanitizeFilename', () => {
  it('strips path components', () => {
    expect(sanitizeFilename('../../etc/passwd.pdf')).toBe('passwd.pdf');
    expect(sanitizeFilename('C:\\Users\\x\\invoice.pdf')).toBe('invoice.pdf');
  });

  it('removes control and bidi override characters', () => {
    expect(sanitizeFilename('inv\u0000oice\u202Efdp.exe')).toBe('invoicefdp.exe');
  });

  it('falls back for empty names and truncates long ones', () => {
    expect(sanitizeFilename('   ')).toBe('unnamed');
    expect(sanitizeFilename(`${'a'.repeat(300)}.pdf`)).toHaveLength(255);
  });
});
