import {
  DetectDocumentTextCommand,
  GetDocumentTextDetectionCommand,
  StartDocumentTextDetectionCommand,
  TextractClient,
} from '@aws-sdk/client-textract';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import type { TextExtractionRequest } from '../../../src/application/ports/index.js';
import { ExternalServiceError } from '../../../src/domain/errors.js';
import { TextractTextExtractor } from '../../../src/infrastructure/aws/textract-text-extractor.js';
import { FAKE_AWS, awsError } from './aws-test-utils.js';

const textractMock = mockClient(TextractClient);
const BUCKET = 'example-invoice-bucket';
const DOC_ID = '6f1c2c1e-6c1a-4a8e-9a43-1f0d6f2a9b10';

const extractor = (maxResultPages = 5) =>
  new TextractTextExtractor(new TextractClient(FAKE_AWS), { bucket: BUCKET, maxResultPages });

const request = (fileType: TextExtractionRequest['fileType']): TextExtractionRequest => ({
  documentId: DOC_ID,
  storageKey: `documents/${DOC_ID}/original.${fileType === 'jpeg' ? 'jpg' : fileType}`,
  fileType,
  attempt: 1,
});

const line = (Text: string, Page: number, Confidence?: number) => ({
  BlockType: 'LINE' as const,
  Text,
  Page,
  ...(Confidence === undefined ? {} : { Confidence }),
});

const errorOf = async (promise: Promise<unknown>) =>
  (await promise.catch((e: unknown) => e)) as ExternalServiceError;

beforeEach(() => {
  textractMock.reset();
});

describe('TextractTextExtractor.start — images (synchronous)', () => {
  it.each(['png', 'jpeg'] as const)(
    'uses DetectDocumentText for %s and maps lines',
    async (type) => {
      textractMock.on(DetectDocumentTextCommand).resolves({
        DocumentMetadata: { Pages: 1 },
        DetectDocumentTextModelVersion: '1.0',
        Blocks: [
          { BlockType: 'PAGE', Page: 1 },
          line('INVOICE INV-0001', 1, 99.5),
          { BlockType: 'WORD', Text: 'INVOICE', Page: 1, Confidence: 99.5 },
          line('Total 60.00', 1, 97),
        ],
      });
      const start = await extractor().start(request(type));

      const input = textractMock.commandCalls(DetectDocumentTextCommand)[0]?.args[0].input;
      expect(input?.Document?.S3Object).toEqual({ Bucket: BUCKET, Name: request(type).storageKey });
      expect(textractMock.commandCalls(StartDocumentTextDetectionCommand)).toHaveLength(0);
      expect(start).toEqual({
        status: 'COMPLETED',
        result: {
          provider: 'aws-textract',
          engineVersion: '1.0',
          text: 'INVOICE INV-0001\nTotal 60.00',
          pageCount: 1,
          confidence: 0.9825,
          lines: [
            { page: 1, text: 'INVOICE INV-0001', confidence: 0.995 },
            { page: 1, text: 'Total 60.00', confidence: 0.97 },
          ],
          warnings: [],
        },
      });
    },
  );

  it('flags empty, missing-confidence and low-confidence results', async () => {
    textractMock
      .on(DetectDocumentTextCommand)
      .resolvesOnce({ Blocks: [] })
      .resolvesOnce({
        Blocks: [line('blurry', 1, 40), line('unknown', 1)],
      });
    const empty = await extractor().start(request('png'));
    const weak = await extractor().start(request('png'));
    expect(empty.status === 'COMPLETED' && empty.result).toMatchObject({
      text: '',
      confidence: 0,
      warnings: ['NO_TEXT_DETECTED'],
    });
    expect(weak.status === 'COMPLETED' && weak.result).toMatchObject({
      confidence: 0.4,
      warnings: ['MISSING_CONFIDENCE', 'LOW_CONFIDENCE'],
    });
  });

  it('rejects a malformed response as permanent', async () => {
    textractMock
      .on(DetectDocumentTextCommand)
      .resolves({ Blocks: [{ BlockType: 'LINE', Text: 'x', Confidence: 250 }] });
    const error = await errorOf(extractor().start(request('png')));
    expect(error.message).toBe('textract DetectDocumentText returned a malformed response');
    expect(error.details).toMatchObject({ retryable: false });
  });
});

describe('TextractTextExtractor.start — PDF (asynchronous)', () => {
  it('starts a job with an idempotency token and job tag', async () => {
    textractMock.on(StartDocumentTextDetectionCommand).resolves({ JobId: 'job-1' });
    expect(await extractor().start(request('pdf'))).toEqual({
      status: 'IN_PROGRESS',
      provider: 'aws-textract',
      jobId: 'job-1',
    });
    const input = textractMock.commandCalls(StartDocumentTextDetectionCommand)[0]?.args[0].input;
    expect(input).toEqual({
      DocumentLocation: { S3Object: { Bucket: BUCKET, Name: request('pdf').storageKey } },
      ClientRequestToken: `${DOC_ID}-1`,
      JobTag: DOC_ID,
    });
    expect(textractMock.commandCalls(DetectDocumentTextCommand)).toHaveLength(0);
  });

  it('uses the same token for a repeated submission of the same attempt', async () => {
    textractMock.on(StartDocumentTextDetectionCommand).resolves({ JobId: 'job-1' });
    await extractor().start(request('pdf'));
    await extractor().start(request('pdf'));
    const tokens = textractMock
      .commandCalls(StartDocumentTextDetectionCommand)
      .map((call) => call.args[0].input.ClientRequestToken);
    expect(tokens).toEqual([`${DOC_ID}-1`, `${DOC_ID}-1`]);
  });

  it('fails when no JobId is returned', async () => {
    textractMock.on(StartDocumentTextDetectionCommand).resolves({});
    const error = await errorOf(extractor().start(request('pdf')));
    expect(error.message).toBe('textract StartDocumentTextDetection returned a malformed response');
  });

  it.each([
    ['ThrottlingException', 400, true],
    ['ProvisionedThroughputExceededException', 400, true],
    ['LimitExceededException', 400, true],
    ['InternalServerError', 500, true],
    ['AccessDeniedException', 400, false],
    ['InvalidS3ObjectException', 400, false],
    ['UnsupportedDocumentException', 400, false],
  ])('maps %s (retryable: %s)', async (name, status, retryable) => {
    textractMock.on(StartDocumentTextDetectionCommand).rejects(awsError(name, status));
    const error = await errorOf(extractor().start(request('pdf')));
    expect(error).toBeInstanceOf(ExternalServiceError);
    expect(error.details).toMatchObject({ awsErrorName: name, retryable });
  });
});

describe('TextractTextExtractor.check', () => {
  const check = (maxResultPages?: number) =>
    extractor(maxResultPages).check({ documentId: DOC_ID, jobId: 'job-1' });

  it('reports a job still in progress', async () => {
    textractMock.on(GetDocumentTextDetectionCommand).resolves({ JobStatus: 'IN_PROGRESS' });
    expect(await check()).toEqual({ status: 'IN_PROGRESS' });
  });

  it('collects every result page of a succeeded multi-page job', async () => {
    textractMock
      .on(GetDocumentTextDetectionCommand)
      .resolvesOnce({
        JobStatus: 'SUCCEEDED',
        NextToken: 'token-2',
        DocumentMetadata: { Pages: 2 },
        Blocks: [line('Page one', 1, 90)],
      })
      .resolvesOnce({ JobStatus: 'SUCCEEDED', Blocks: [line('Page two', 2, 80)] });

    const result = await check();
    expect(result).toMatchObject({
      status: 'COMPLETED',
      result: { pageCount: 2, text: 'Page one\nPage two', confidence: 0.85 },
    });
    const calls = textractMock.commandCalls(GetDocumentTextDetectionCommand);
    expect(calls.map((c) => c.args[0].input.NextToken)).toEqual([undefined, 'token-2']);
    expect(calls[0]?.args[0].input).toMatchObject({ JobId: 'job-1', MaxResults: 1000 });
  });

  it.each([
    ['FAILED', 'JOB_FAILED'],
    ['PARTIAL_SUCCESS', 'PARTIAL_SUCCESS'],
  ])('maps job status %s to FAILED(%s)', async (JobStatus, reason) => {
    textractMock
      .on(GetDocumentTextDetectionCommand)
      .resolves({ JobStatus: JobStatus as 'FAILED', StatusMessage: 'internal detail' });
    expect(await check()).toEqual({ status: 'FAILED', reason });
  });

  it('stops at the configured result-page limit', async () => {
    textractMock
      .on(GetDocumentTextDetectionCommand)
      .resolves({ JobStatus: 'SUCCEEDED', NextToken: 'more', Blocks: [line('x', 1, 90)] });
    const error = await errorOf(check(2));
    expect(error.message).toBe('textract result exceeds the configured page limit');
    expect(textractMock.commandCalls(GetDocumentTextDetectionCommand)).toHaveLength(2);
  });

  it('rejects a malformed or unknown job status', async () => {
    textractMock.on(GetDocumentTextDetectionCommand).resolves({});
    const error = await errorOf(check());
    expect(error.details).toMatchObject({ retryable: false });
  });

  it.each([
    ['ThrottlingException', 400, true],
    ['InvalidJobIdException', 400, false],
    ['AccessDeniedException', 400, false],
  ])('maps %s on status checks (retryable: %s)', async (name, status, retryable) => {
    textractMock.on(GetDocumentTextDetectionCommand).rejects(awsError(name, status));
    const error = await errorOf(check());
    expect(error.details).toMatchObject({ operation: 'GetDocumentTextDetection', retryable });
  });
});

describe('TextractTextExtractor — routing and deterministic limits', () => {
  it('reports PDFs as asynchronous and images as synchronous', () => {
    const e = extractor();
    expect(e.isAsynchronous('pdf')).toBe(true);
    expect(e.isAsynchronous('png')).toBe(false);
    expect(e.isAsynchronous('jpeg')).toBe(false);
  });

  it('flags a result-page limit breach as a deterministic, non-retryable failure (L5)', async () => {
    textractMock
      .on(GetDocumentTextDetectionCommand)
      .resolves({ JobStatus: 'SUCCEEDED', NextToken: 'more', Blocks: [] });
    const error = await errorOf(extractor(1).check({ documentId: DOC_ID, jobId: 'job-1' }));
    expect(error.details).toMatchObject({
      retryable: false,
      failureCode: 'RESULT_LIMIT_EXCEEDED',
    });
  });

  it('classifies a socket reset during a status check as retryable (H1)', async () => {
    textractMock
      .on(GetDocumentTextDetectionCommand)
      .rejects(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    const error = await errorOf(extractor().check({ documentId: DOC_ID, jobId: 'job-1' }));
    expect(error.details).toMatchObject({ retryable: true, networkCode: 'ECONNRESET' });
  });
});
