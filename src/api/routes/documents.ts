import type { MultipartFile } from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { Services } from '../../container.js';
import { ValidationError } from '../../domain/errors.js';
import { HttpError } from '../errors.js';
import {
  documentIdParamsSchema,
  documentResponseSchema,
  toDocumentResponse,
} from '../schemas/document.js';

interface UploadedFile {
  filename: string;
  mimetype: string;
  content: Buffer;
}

/** Reads exactly one file part; rejects zero or multiple files. Size limits are enforced while streaming. */
async function readSingleFile(parts: AsyncIterableIterator<unknown>): Promise<UploadedFile> {
  let upload: UploadedFile | undefined;
  for await (const part of parts) {
    const file = part as Partial<MultipartFile>;
    if (file.type !== 'file' || !file.toBuffer) continue;
    if (upload) {
      throw new ValidationError('Exactly one file must be uploaded per request');
    }
    upload = {
      filename: file.filename ?? '',
      mimetype: file.mimetype ?? '',
      content: await file.toBuffer(),
    };
  }
  if (!upload) {
    throw new ValidationError('A file must be provided in the "file" field');
  }
  return upload;
}

export const documentRoutes =
  (services: Services): FastifyPluginAsyncZod =>
  (app) => {
    app.post(
      '/documents',
      {
        schema: {
          summary: 'Upload a document',
          description:
            'Multipart upload with a single file (PDF, PNG or JPEG). Extension, declared content type and file signature must agree.',
          tags: ['documents'],
          consumes: ['multipart/form-data'],
          response: { 201: documentResponseSchema },
        },
      },
      async (request, reply) => {
        if (!request.isMultipart()) {
          throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request must be multipart/form-data');
        }
        const file = await readSingleFile(request.parts());
        const document = await services.ingestDocument.execute({
          filename: file.filename,
          declaredMimeType: file.mimetype,
          content: file.content,
        });
        return reply
          .code(201)
          .header('location', `/v1/documents/${document.id}`)
          .send(toDocumentResponse(document));
      },
    );

    app.get(
      '/documents/:id',
      {
        schema: {
          summary: 'Get a document and its processing history',
          tags: ['documents'],
          params: documentIdParamsSchema,
          response: { 200: documentResponseSchema },
        },
      },
      async (request) => toDocumentResponse(await services.getDocument.execute(request.params.id)),
    );

    app.post(
      '/documents/:id/process',
      {
        schema: {
          summary: 'Run extraction and classification (synchronous in Milestone 1)',
          description: 'Allowed from STORED, or from FAILED as a retry.',
          tags: ['documents'],
          params: documentIdParamsSchema,
          response: { 200: documentResponseSchema },
        },
      },
      async (request) =>
        toDocumentResponse(await services.processDocument.execute(request.params.id)),
    );

    return Promise.resolve();
  };
