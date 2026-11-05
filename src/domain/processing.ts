import { z } from 'zod';

const confidence = z.number().min(0).max(1);

/** Contract every OCR/extraction adapter must satisfy; validated at the application boundary. */
export const extractionResultSchema = z.object({
  provider: z.string().min(1),
  text: z.string(),
  pageCount: z.number().int().nonnegative(),
  confidence,
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

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
