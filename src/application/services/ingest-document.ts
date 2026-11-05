import { createHash } from 'node:crypto';
import { createDocument, transitionDocument, type DocumentRecord } from '../../domain/document.js';
import { ExternalServiceError } from '../../domain/errors.js';
import { SUPPORTED_FILE_TYPES } from '../../domain/file-type.js';
import {
  sanitizeFilename,
  validateUpload,
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
}

export class IngestDocumentService {
  constructor(private readonly deps: IngestDocumentDeps) {}

  async execute(upload: UploadCandidate): Promise<DocumentRecord> {
    const { repository, storage, clock, ids, logger, maxUploadBytes } = this.deps;
    const fileType = validateUpload(upload, maxUploadBytes);
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
      await storage.put(document.storageKey, upload.content, mimeType);
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
