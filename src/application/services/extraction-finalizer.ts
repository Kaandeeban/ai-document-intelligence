import { transitionDocument, type DocumentRecord } from '../../domain/document.js';
import {
  EXTRACTION_ARTIFACT_CONTENT_TYPE,
  buildExtractionArtifact,
  extractionArtifactKey,
  serializeExtractionArtifact,
} from '../../domain/extraction-artifact.js';
import { classificationResultSchema, type ExtractionResult } from '../../domain/processing.js';
import type {
  Clock,
  DocumentClassifier,
  DocumentRepository,
  DocumentStorage,
  Logger,
} from '../ports/index.js';
import { callAdapter, parseAdapterResponse } from './processing-support.js';

export interface ExtractionFinalizerDeps {
  readonly repository: DocumentRepository;
  readonly storage: DocumentStorage;
  readonly classifier: DocumentClassifier;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Shared final stage for both synchronous and asynchronous OCR: persist the
 * extraction artifact, classify, and mark the document PROCESSED.
 * Expects a document in PROCESSING; failures propagate to the caller.
 */
export class ExtractionFinalizer {
  constructor(private readonly deps: ExtractionFinalizerDeps) {}

  async finalize(
    document: DocumentRecord,
    result: ExtractionResult,
    extractionStartedAt: Date,
  ): Promise<DocumentRecord> {
    const { repository, storage, classifier, clock, logger } = this.deps;

    const artifact = buildExtractionArtifact(document, result, extractionStartedAt, clock.now());
    await callAdapter('Extraction artifact storage', () =>
      storage.put(extractionArtifactKey(document.id), serializeExtractionArtifact(artifact), {
        contentType: EXTRACTION_ARTIFACT_CONTENT_TYPE,
        metadata: { 'document-id': document.id },
        // A retry after a later-stage failure replaces the previous attempt's artifact.
        overwrite: true,
      }),
    );

    const rawClassification = await callAdapter('Classification', () =>
      classifier.classify({ documentId: document.id, text: result.text }),
    );
    const classification = parseAdapterResponse(
      classificationResultSchema,
      rawClassification,
      'Classification',
    );

    const completedAt = clock.now();
    const processed: DocumentRecord = {
      ...transitionDocument(document, 'PROCESSED', completedAt),
      processing: {
        extraction: {
          provider: result.provider,
          pageCount: result.pageCount,
          characterCount: result.text.length,
          confidence: result.confidence,
        },
        classification,
        completedAt,
      },
    };
    await repository.save(processed);
    logger.info(
      {
        documentId: document.id,
        pageCount: result.pageCount,
        documentClass: classification.documentClass,
      },
      'Document processed',
    );
    return processed;
  }
}
