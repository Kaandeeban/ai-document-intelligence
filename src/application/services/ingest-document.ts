import { createHash } from 'node:crypto';
import { createDocument, transitionDocument, type DocumentRecord } from '../../domain/document.js';
import { ExternalServiceError } from '../../domain/errors.js';
import { SUPPORTED_FILE_TYPES } from '../../domain/file-type.js';
import {
  sanitizeFilename,
  validateUpload,
  type MaxBytesByType,
  type UploadCandidate,
} from '../../domain/upload-policy.js';
import type {
  Clock,
  DocumentRepository,
  DocumentStorage,
  IdGenerator,
  Logger,
} from '../ports/index.js';

export interface IngestDocumentDeps {
  readonly repository: DocumentRepository;
  readonly storage: DocumentStorage;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly maxUploadBytes: number;
  /** Stricter per-type limits imposed by the configured OCR engine. */
  readonly maxBytesByType?: MaxBytesByType;
}

export class IngestDocumentService {
  constructor(private readonly deps: IngestDocumentDeps) {}

  async execute(upload: UploadCandidate): Promise<DocumentRecord> {
    const { repository, storage, clock, ids, logger, maxUploadBytes, maxBytesByType } = this.deps;
    const fileType = validateUpload(upload, maxUploadBytes, maxBytesByType);
    const mimeType = SUPPORTED_FILE_TYPES[fileType].mimeType;

    let document = createDocument({
      id: ids.newId(),
      originalFilename: sanitizeFilename(upload.filename),
      fileType,
      mimeType,
      sizeBytes: upload.content.byteLength,
      sha256: createHash('sha256').update(upload.content).digest('hex'),
      now: clock.now(),
    });
    await repository.save(document);

    try {
      await storage.put(document.storageKey, upload.content, {
        contentType: mimeType,
        sha256Hex: document.sha256,
        metadata: { 'document-id': document.id },
      });
    } catch (cause) {
      document = transitionDocument(document, 'FAILED', clock.now(), 'Storage write failed');
      await repository.save(document);
      logger.error({ documentId: document.id, err: cause }, 'Document storage failed');
      throw new ExternalServiceError(
        'Failed to store document',
        { documentId: document.id },
        { cause },
      );
    }

    document = transitionDocument(document, 'STORED', clock.now());
    await repository.save(document);
    logger.info(
      { documentId: document.id, fileType, sizeBytes: document.sizeBytes },
      'Document ingested',
    );
    return document;
  }
}
