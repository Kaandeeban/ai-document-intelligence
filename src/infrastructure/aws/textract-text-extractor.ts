import {
  DetectDocumentTextCommand,
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  type TextractClient,
} from '@aws-sdk/client-textract';
import type { z } from 'zod';
import type {
  ExtractionJobRequest,
  TextExtractionRequest,
  TextExtractor,
} from '../../application/ports/index.js';
import { ExternalServiceError } from '../../domain/errors.js';
import type { SupportedFileType } from '../../domain/file-type.js';
import type { ExtractionCheck, ExtractionStart } from '../../domain/processing.js';
import { toExternalServiceError } from './aws-error.js';
import {
  TEXTRACT_PROVIDER,
  detectResponseSchema,
  getResponseSchema,
  mapTextractBlocks,
  startResponseSchema,
  type TextractBlock,
} from './textract-response.js';

export interface TextractTextExtractorOptions {
  /** Bucket holding the documents; Textract reads objects directly from S3. */
  readonly bucket: string;
  /** Maximum GetDocumentTextDetection result pages fetched per job (memory bound). */
  readonly maxResultPages: number;
}

const RESULTS_PER_PAGE = 1000;

/**
 * Textract's synchronous operations (DetectDocumentText) accept documents up to
 * 10 MB. Interpreted conservatively as 10,000,000 bytes (decimal MB), since the
 * binary interpretation (10 MiB) is not confirmed by AWS documentation. Images always take the synchronous path, so uploads above this are
 * rejected at ingestion when the Textract adapter is enabled.
 */
export const TEXTRACT_SYNC_MAX_BYTES = 10_000_000;
export const TEXTRACT_SYNC_IMAGE_LIMITS = {
  png: TEXTRACT_SYNC_MAX_BYTES,
  jpeg: TEXTRACT_SYNC_MAX_BYTES,
} as const;

/**
 * Hybrid Textract OCR:
 * - PNG/JPEG: synchronous DetectDocumentText → COMPLETED.
 * - PDF: asynchronous StartDocumentTextDetection → IN_PROGRESS, later `check`.
 * Extracted text is never logged.
 */
export class TextractTextExtractor implements TextExtractor {
  constructor(
    private readonly client: TextractClient,
    private readonly options: TextractTextExtractorOptions,
  ) {}

  /** PDFs always use the asynchronous API (page count unknown before OCR). */
  isAsynchronous(fileType: SupportedFileType): boolean {
    return fileType === 'pdf';
  }

  async start(request: TextExtractionRequest): Promise<ExtractionStart> {
    const s3Object = { Bucket: this.options.bucket, Name: request.storageKey };

    if (this.isAsynchronous(request.fileType)) {
      const raw = await this.send('StartDocumentTextDetection', () =>
        this.client.send(
          new StartDocumentTextDetectionCommand({
            DocumentLocation: { S3Object: s3Object },
            // Same token for the same attempt → Textract returns the existing job
            // instead of starting (and billing) a duplicate.
            ClientRequestToken: `${request.documentId}-${request.attempt}`,
            // Lets a future SNS completion notification be mapped to the document.
            JobTag: request.documentId,
          }),
        ),
      );
      const { JobId } = this.parse(startResponseSchema, raw, 'StartDocumentTextDetection');
      return { status: 'IN_PROGRESS', provider: TEXTRACT_PROVIDER, jobId: JobId };
    }

    const raw = await this.send('DetectDocumentText', () =>
      this.client.send(new DetectDocumentTextCommand({ Document: { S3Object: s3Object } })),
    );
    const response = this.parse(detectResponseSchema, raw, 'DetectDocumentText');
    return {
      status: 'COMPLETED',
      result: mapTextractBlocks({
        blocks: response.Blocks ?? [],
        ...(response.DocumentMetadata?.Pages === undefined
          ? {}
          : { declaredPages: response.DocumentMetadata.Pages }),
        ...(response.DetectDocumentTextModelVersion === undefined
          ? {}
          : { modelVersion: response.DetectDocumentTextModelVersion }),
      }),
    };
  }

  async check(request: ExtractionJobRequest): Promise<ExtractionCheck> {
    const blocks: TextractBlock[] = [];
    let declaredPages: number | undefined;
    let modelVersion: string | undefined;
    let nextToken: string | undefined;
    let resultPages = 0;

    do {
      if (resultPages >= this.options.maxResultPages) {
        // Deterministic for this document: never retryable, and flagged so the
        // document is not resubmitted (each resubmission is a new billable job).
        throw new ExternalServiceError('textract result exceeds the configured page limit', {
          provider: 'textract',
          operation: 'GetDocumentTextDetection',
          retryable: false,
          failureCode: 'RESULT_LIMIT_EXCEEDED',
          maxResultPages: this.options.maxResultPages,
        });
      }
      const token = nextToken;
      const raw = await this.send('GetDocumentTextDetection', () =>
        this.client.send(
          new GetDocumentTextDetectionCommand({
            JobId: request.jobId,
            MaxResults: RESULTS_PER_PAGE,
            ...(token === undefined ? {} : { NextToken: token }),
          }),
        ),
      );
      const response = this.parse(getResponseSchema, raw, 'GetDocumentTextDetection');
      resultPages += 1;

      switch (response.JobStatus) {
        case 'IN_PROGRESS':
          return { status: 'IN_PROGRESS' };
        case 'FAILED':
          return { status: 'FAILED', reason: 'JOB_FAILED' };
        case 'PARTIAL_SUCCESS':
          // Missing pages would make invoice totals unreliable (Milestone 2 decision).
          return { status: 'FAILED', reason: 'PARTIAL_SUCCESS' };
        case 'SUCCEEDED':
          blocks.push(...(response.Blocks ?? []));
          declaredPages ??= response.DocumentMetadata?.Pages;
          modelVersion ??= response.DetectDocumentTextModelVersion;
          nextToken = response.NextToken;
      }
    } while (nextToken !== undefined);

    return {
      status: 'COMPLETED',
      result: mapTextractBlocks({
        blocks,
        ...(declaredPages === undefined ? {} : { declaredPages }),
        ...(modelVersion === undefined ? {} : { modelVersion }),
      }),
    };
  }

  private async send<T>(operation: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw toExternalServiceError(error, { provider: 'textract', operation });
    }
  }

  private parse<S extends z.ZodType>(schema: S, raw: unknown, operation: string): z.output<S> {
    const result = schema.safeParse(raw);
    if (!result.success) {
      throw new ExternalServiceError(`textract ${operation} returned a malformed response`, {
        provider: 'textract',
        operation,
        retryable: false,
      });
    }
    return result.data;
  }
}
