import type { z } from 'zod';
import { transitionDocument, type DocumentRecord } from '../../domain/document.js';
import { DocumentNotFoundError, ExternalServiceError } from '../../domain/errors.js';
import {
  classificationResultSchema,
  extractionResultSchema,
  type ClassificationResult,
  type ExtractionResult,
} from '../../domain/processing.js';
import type {
  Clock,
  DocumentClassifier,
  DocumentRepository,
  Logger,
  TextExtractor,
} from '../ports/index.js';

export interface ProcessDocumentDeps {
  readonly repository: DocumentRepository;
  readonly extractor: TextExtractor;
  readonly classifier: DocumentClassifier;
  readonly clock: Clock;
  readonly logger: Logger;
}

/**
 * Orchestrates extraction then classification for a stored document.
 * Runs synchronously in Milestone 1; Milestone 4 moves it behind SQS.
 * Every adapter response is re-validated here so a faulty adapter cannot
 * corrupt persisted state.
 */
export class ProcessDocumentService {
  constructor(private readonly deps: ProcessDocumentDeps) {}

  async execute(id: string): Promise<DocumentRecord> {
    const { repository, clock, logger } = this.deps;
    const existing = await repository.findById(id);
    if (!existing) {
      throw new DocumentNotFoundError('Document not found', { documentId: id });
    }

    let document = transitionDocument(existing, 'PROCESSING', clock.now());
    await repository.save(document);

    try {
      const extraction = await this.extract(document);
      const classification = await this.classify(document.id, extraction.text);
      const completedAt = clock.now();
      document = {
        ...transitionDocument(document, 'PROCESSED', completedAt),
        processing: {
          extraction: {
            provider: extraction.provider,
            pageCount: extraction.pageCount,
            characterCount: extraction.text.length,
            confidence: extraction.confidence,
          },
          classification,
          completedAt,
        },
      };
      await repository.save(document);
      logger.info(
        { documentId: id, documentClass: classification.documentClass },
        'Document processed',
      );
      return document;
    } catch (error) {
      const reason =
        error instanceof ExternalServiceError ? error.message : 'Unexpected processing error';
      document = transitionDocument(document, 'FAILED', clock.now(), reason);
      await repository.save(document);
      logger.error({ documentId: id, err: error }, 'Document processing failed');
      throw error instanceof ExternalServiceError
        ? error
        : new ExternalServiceError(
            'Document processing failed',
            { documentId: id },
            { cause: error },
          );
    }
  }

  private async extract(document: DocumentRecord): Promise<ExtractionResult> {
    const raw = await this.callAdapter('Text extraction', () =>
      this.deps.extractor.extract({
        documentId: document.id,
        storageKey: document.storageKey,
        fileType: document.fileType,
      }),
    );
    return parseAdapterResponse(extractionResultSchema, raw, 'Text extraction');
  }

  private async classify(documentId: string, text: string): Promise<ClassificationResult> {
    const raw = await this.callAdapter('Classification', () =>
      this.deps.classifier.classify({ documentId, text }),
    );
    return parseAdapterResponse(classificationResultSchema, raw, 'Classification');
  }

  private async callAdapter<T>(stage: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (cause) {
      throw new ExternalServiceError(`${stage} failed`, { stage }, { cause });
    }
  }
}

function parseAdapterResponse<S extends z.ZodType>(
  schema: S,
  raw: unknown,
  stage: string,
): z.output<S> {
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw new ExternalServiceError(`${stage} returned an invalid response`, {
      stage,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
  return result.data;
}
