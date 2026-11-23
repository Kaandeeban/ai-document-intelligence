/**
 * Validation and mapping of Textract responses into provider-neutral domain
 * types. Only the fields we use are validated; raw responses never leave this
 * module.
 */
import { z } from 'zod';
import type { ExtractedLine, ExtractionResult } from '../../domain/processing.js';

export const TEXTRACT_PROVIDER = 'aws-textract';

const blockSchema = z.object({
  BlockType: z.string().optional(),
  Text: z.string().optional(),
  Confidence: z.number().min(0).max(100).optional(),
  Page: z.number().int().positive().optional(),
});
export type TextractBlock = z.infer<typeof blockSchema>;

const documentMetadataSchema = z.object({ Pages: z.number().int().nonnegative().optional() });

export const detectResponseSchema = z.object({
  Blocks: z.array(blockSchema).optional(),
  DocumentMetadata: documentMetadataSchema.optional(),
  DetectDocumentTextModelVersion: z.string().optional(),
});

export const startResponseSchema = z.object({ JobId: z.string().min(1) });

export const getResponseSchema = z.object({
  JobStatus: z.enum(['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'PARTIAL_SUCCESS']),
  NextToken: z.string().min(1).optional(),
  Blocks: z.array(blockSchema).optional(),
  DocumentMetadata: documentMetadataSchema.optional(),
  DetectDocumentTextModelVersion: z.string().optional(),
});

/** Domain warnings attached to the result; never contain document text. */
export const OCR_WARNINGS = {
  noText: 'NO_TEXT_DETECTED',
  missingConfidence: 'MISSING_CONFIDENCE',
  lowConfidence: 'LOW_CONFIDENCE',
} as const;

const LOW_CONFIDENCE_THRESHOLD = 0.8;

const toUnitConfidence = (value: number | undefined): number | null =>
  value === undefined ? null : Math.round((value / 100) * 10_000) / 10_000;

export interface MapBlocksInput {
  readonly blocks: readonly TextractBlock[];
  readonly declaredPages?: number;
  readonly modelVersion?: string;
}

export function mapTextractBlocks(input: MapBlocksInput): ExtractionResult {
  const lines: ExtractedLine[] = input.blocks
    .filter((block) => block.BlockType === 'LINE' && block.Text !== undefined)
    .map((block) => ({
      page: block.Page ?? 1,
      text: block.Text ?? '',
      confidence: toUnitConfidence(block.Confidence),
    }))
    // Stable sort keeps Textract's reading order within each page.
    .sort((a, b) => a.page - b.page);

  const pageBlocks = input.blocks.filter((block) => block.BlockType === 'PAGE').length;
  const highestLinePage = lines.reduce((max, line) => Math.max(max, line.page), 0);
  const pageCount = input.declaredPages ?? Math.max(pageBlocks, highestLinePage);

  const known = lines.flatMap((line) => (line.confidence === null ? [] : [line.confidence]));
  const confidence =
    known.length === 0
      ? 0
      : Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10_000) / 10_000;

  const warnings: string[] = [];
  if (lines.length === 0) warnings.push(OCR_WARNINGS.noText);
  if (known.length < lines.length) warnings.push(OCR_WARNINGS.missingConfidence);
  if (known.length > 0 && confidence < LOW_CONFIDENCE_THRESHOLD) {
    warnings.push(OCR_WARNINGS.lowConfidence);
  }

  return {
    provider: TEXTRACT_PROVIDER,
    ...(input.modelVersion === undefined ? {} : { engineVersion: input.modelVersion }),
    text: lines.map((line) => line.text).join('\n'),
    pageCount,
    confidence,
    lines,
    warnings,
  };
}
