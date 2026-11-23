import { z } from 'zod';

const confidence = z.number().min(0).max(1);

export const extractedLineSchema = z.object({
  page: z.number().int().positive(),
  text: z.string(),
  /** 0–1, or null when the OCR engine did not report a confidence. */
  confidence: confidence.nullable(),
});
export type ExtractedLine = z.infer<typeof extractedLineSchema>;

/** Contract every OCR/extraction adapter must satisfy; validated at the application boundary. */
export const extractionResultSchema = z.object({
  provider: z.string().min(1),
  engineVersion: z.string().min(1).optional(),
  text: z.string(),
  pageCount: z.number().int().nonnegative(),
  confidence,
  lines: z.array(extractedLineSchema).optional(),
  warnings: z.array(z.string().min(1)).optional(),
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/** First phase of OCR: either finished immediately (sync) or a job was started (async). */
export const extractionStartSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('COMPLETED'), result: extractionResultSchema }),
  z.object({
    status: z.literal('IN_PROGRESS'),
    provider: z.string().min(1),
    jobId: z.string().min(1).max(512),
  }),
]);
export type ExtractionStart = z.infer<typeof extractionStartSchema>;

export const EXTRACTION_FAILURE_REASONS = ['JOB_FAILED', 'PARTIAL_SUCCESS'] as const;
export type ExtractionFailureReason = (typeof EXTRACTION_FAILURE_REASONS)[number];

/** Second phase of OCR: the state of a previously started job. */
export const extractionCheckSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('IN_PROGRESS') }),
  z.object({ status: z.literal('COMPLETED'), result: extractionResultSchema }),
  z.object({ status: z.literal('FAILED'), reason: z.enum(EXTRACTION_FAILURE_REASONS) }),
]);
export type ExtractionCheck = z.infer<typeof extractionCheckSchema>;

export const DOCUMENT_CLASSES = [
  'INVOICE',
  'CREDIT_NOTE',
  'RECEIPT',
  'PURCHASE_ORDER',
  'OTHER',
] as const;
export type DocumentClass = (typeof DOCUMENT_CLASSES)[number];

/**
 * Contract every classification adapter must satisfy. Model and prompt
 * versions are mandatory so every result is auditable and reproducible.
 */
export const classificationResultSchema = z.object({
  provider: z.string().min(1),
  modelVersion: z.string().min(1),
  promptVersion: z.string().min(1),
  documentClass: z.enum(DOCUMENT_CLASSES),
  confidence,
});
export type ClassificationResult = z.infer<typeof classificationResultSchema>;

export interface ProcessingOutcome {
  readonly extraction: {
    readonly provider: string;
    readonly pageCount: number;
    readonly characterCount: number;
    readonly confidence: number;
  };
  readonly classification: ClassificationResult;
  readonly completedAt: Date;
}
