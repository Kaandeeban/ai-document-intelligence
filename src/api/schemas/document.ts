import { z } from 'zod';
import { DOCUMENT_STATUSES, type DocumentRecord } from '../../domain/document.js';
import { SUPPORTED_FILE_TYPE_NAMES } from '../../domain/file-type.js';
import { DOCUMENT_CLASSES } from '../../domain/processing.js';

export const documentIdParamsSchema = z.object({ id: z.uuid() });

/** Public API representation. Internal fields such as the storage key are deliberately omitted. */
export const documentResponseSchema = z.object({
  id: z.uuid(),
  filename: z.string(),
  fileType: z.enum(SUPPORTED_FILE_TYPE_NAMES as [string, ...string[]]),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  status: z.enum(DOCUMENT_STATUSES),
  statusHistory: z.array(
    z.object({
      status: z.enum(DOCUMENT_STATUSES),
      at: z.iso.datetime(),
      reason: z.string().optional(),
    }),
  ),
  processing: z
    .object({
      extraction: z.object({
        provider: z.string(),
        pageCount: z.number().int(),
        characterCount: z.number().int(),
        confidence: z.number(),
      }),
      classification: z.object({
        provider: z.string(),
        modelVersion: z.string(),
        promptVersion: z.string(),
        documentClass: z.enum(DOCUMENT_CLASSES),
        confidence: z.number(),
      }),
      completedAt: z.iso.datetime(),
    })
    .optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type DocumentResponse = z.infer<typeof documentResponseSchema>;

export function toDocumentResponse(document: DocumentRecord): DocumentResponse {
  const { processing } = document;
  return {
    id: document.id,
    filename: document.originalFilename,
    fileType: document.fileType,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    sha256: document.sha256,
    status: document.status,
    statusHistory: document.statusHistory.map((change) => ({
      status: change.status,
      at: change.at.toISOString(),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
    })),
    ...(processing === undefined
      ? {}
      : {
          processing: {
            extraction: processing.extraction,
            classification: processing.classification,
            completedAt: processing.completedAt.toISOString(),
          },
        }),
    createdAt: document.createdAt.toISOString(),
    updatedAt: document.updatedAt.toISOString(),
  };
}
