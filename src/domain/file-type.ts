export const SUPPORTED_FILE_TYPES = {
  pdf: { mimeType: 'application/pdf', extensions: ['.pdf'] },
  png: { mimeType: 'image/png', extensions: ['.png'] },
  jpeg: { mimeType: 'image/jpeg', extensions: ['.jpg', '.jpeg'] },
} as const;

export type SupportedFileType = keyof typeof SUPPORTED_FILE_TYPES;

export const SUPPORTED_FILE_TYPE_NAMES = Object.keys(SUPPORTED_FILE_TYPES) as SupportedFileType[];

export const ALLOWED_EXTENSIONS: readonly string[] = SUPPORTED_FILE_TYPE_NAMES.flatMap(
  (type) => SUPPORTED_FILE_TYPES[type].extensions,
);

export const ALLOWED_MIME_TYPES: readonly string[] = SUPPORTED_FILE_TYPE_NAMES.map(
  (type) => SUPPORTED_FILE_TYPES[type].mimeType,
);

/**
 * Magic-byte signatures. PDF is required at offset 0 (stricter than the spec's
 * 1024-byte allowance) to reject polyglot files carrying a prefixed payload.
 */
const SIGNATURES: readonly { type: SupportedFileType; bytes: readonly number[] }[] = [
  { type: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
  { type: 'png', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'jpeg', bytes: [0xff, 0xd8, 0xff] },
];

export function detectFileType(content: Uint8Array): SupportedFileType | undefined {
  return SIGNATURES.find(
    ({ bytes }) => bytes.length <= content.length && bytes.every((byte, i) => content[i] === byte),
  )?.type;
}

export function fileTypeFromExtension(filename: string): SupportedFileType | undefined {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  const extension = filename.slice(dot).toLowerCase();
  return SUPPORTED_FILE_TYPE_NAMES.find((type) =>
    (SUPPORTED_FILE_TYPES[type].extensions as readonly string[]).includes(extension),
  );
}

export function fileTypeFromMimeType(mimeType: string): SupportedFileType | undefined {
  const essence = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return SUPPORTED_FILE_TYPE_NAMES.find((type) => SUPPORTED_FILE_TYPES[type].mimeType === essence);
}
