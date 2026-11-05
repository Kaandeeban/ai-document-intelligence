import { EmptyFileError, FileTooLargeError, UnsupportedFileTypeError } from './errors.js';
import {
  ALLOWED_EXTENSIONS,
  ALLOWED_MIME_TYPES,
  type SupportedFileType,
  detectFileType,
  fileTypeFromExtension,
  fileTypeFromMimeType,
} from './file-type.js';

export interface UploadCandidate {
  readonly filename: string;
  readonly declaredMimeType: string;
  readonly content: Uint8Array;
}

const MAX_FILENAME_LENGTH = 255;

/**
 * Accepts an upload only when the extension, declared MIME type and actual
 * content signature all agree on one supported type. Returns that type.
 */
export function validateUpload(candidate: UploadCandidate, maxBytes: number): SupportedFileType {
  const { content, filename, declaredMimeType } = candidate;
  if (content.byteLength === 0) {
    throw new EmptyFileError('Uploaded file is empty');
  }
  if (content.byteLength > maxBytes) {
    throw new FileTooLargeError(`File exceeds the maximum size of ${maxBytes} bytes`, { maxBytes });
  }

  const byExtension = fileTypeFromExtension(filename);
  if (!byExtension) {
    throw new UnsupportedFileTypeError('File extension is not allowed', {
      allowed: ALLOWED_EXTENSIONS,
    });
  }
  const byMimeType = fileTypeFromMimeType(declaredMimeType);
  if (!byMimeType) {
    throw new UnsupportedFileTypeError('Declared content type is not allowed', {
      allowed: ALLOWED_MIME_TYPES,
    });
  }
  const detected = detectFileType(content);
  if (!detected) {
    throw new UnsupportedFileTypeError('File content does not match a supported format');
  }
  if (byExtension !== detected || byMimeType !== detected) {
    throw new UnsupportedFileTypeError('File extension, content type and content do not match', {
      extension: byExtension,
      declaredMimeType: byMimeType,
      detectedContent: detected,
    });
  }
  return detected;
}

// C0/C1 control characters plus Unicode bidi overrides (used to disguise extensions).
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Produces a display-safe filename: strips path components, control characters
 * and bidi overrides. The result is metadata only and is never used to build
 * storage keys or filesystem paths.
 */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? '';
  const cleaned = base.replace(UNSAFE_FILENAME_CHARS, '').trim().slice(0, MAX_FILENAME_LENGTH);
  return cleaned.length > 0 ? cleaned : 'unnamed';
}
