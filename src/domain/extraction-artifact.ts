import { z } from 'zod';
import type { DocumentRecord } from './document.js';
import { extractedLineSchema, type ExtractionResult } from './processing.js';

/**
 * Versioned, provider-neutral record of an OCR run, persisted next to the
 * original document. Raw provider responses are deliberately not stored.
 * Bump the schema version on any breaking change to this shape.
 */
export const EXTRACTION_ARTIFACT_SCHEMA_VERSION = 1;

const confidence = z.number().min(0).max(1);

export const extractionArtifactSchema = z.object({
  schemaVersion: z.literal(EXTRACTION_ARTIFACT_SCHEMA_VERSION),
  documentId: z.uuid(),
  attempt: z.number().int().positive(),
  engine: z.object({
    provider: z.string().min(1),
    version: z.string().min(1).optional(),
  }),
  extractionStartedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  pageCount: z.number().int().nonnegative(),
  confidence,
  pages: z.array(
    z.object({
      pageNumber: z.number().int().positive(),
      lineCount: z.number().int().nonnegative(),
      confidence: confidence.nullable(),
    }),
  ),
  lines: z.array(extractedLineSchema),
  text: z.string(),
  warnings: z.array(z.string()),
});
export type ExtractionArtifact = z.infer<typeof extractionArtifactSchema>;

export const EXTRACTION_ARTIFACT_CONTENT_TYPE = 'application/json';

export function extractionArtifactKey(documentId: string): string {
  return `documents/${documentId}/extraction.json`;
}

const mean = (values: readonly number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;

function summarisePages(result: ExtractionResult): ExtractionArtifact['pages'] {
  const lines = result.lines ?? [];
  const highestLinePage = lines.reduce((max, line) => Math.max(max, line.page), 0);
  const pageCount = Math.max(result.pageCount, highestLinePage);
  return Array.from({ length: pageCount }, (_, index) => {
    const pageLines = lines.filter((line) => line.page === index + 1);
    const known = pageLines.flatMap((line) => (line.confidence === null ? [] : [line.confidence]));
    return { pageNumber: index + 1, lineCount: pageLines.length, confidence: mean(known) };
  });
}

/** Builds and validates the artifact. Throws if the inputs cannot form a valid artifact. */
export function buildExtractionArtifact(
  document: DocumentRecord,
  result: ExtractionResult,
  extractionStartedAt: Date,
  completedAt: Date,
): ExtractionArtifact {
  return extractionArtifactSchema.parse({
    schemaVersion: EXTRACTION_ARTIFACT_SCHEMA_VERSION,
    documentId: document.id,
    attempt: Math.max(document.processingAttempts, 1),
    engine: {
      provider: result.provider,
      ...(result.engineVersion === undefined ? {} : { version: result.engineVersion }),
    },
    extractionStartedAt: extractionStartedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    pageCount: result.pageCount,
    confidence: result.confidence,
    pages: summarisePages(result),
    lines: result.lines ?? [],
    text: result.text,
    warnings: result.warnings ?? [],
  });
}

export function serializeExtractionArtifact(artifact: ExtractionArtifact): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(artifact));
}
