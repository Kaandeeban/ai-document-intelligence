import { createHash } from 'node:crypto';
import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { storageKeyFor } from '../../../src/domain/document.js';
import { ExternalServiceError } from '../../../src/domain/errors.js';
import { S3DocumentStorage } from '../../../src/infrastructure/aws/s3-document-storage.js';
import { pdfBytes } from '../../support/fixtures.js';
import { FAKE_AWS, awsError } from './aws-test-utils.js';

const s3Mock = mockClient(S3Client);
const BUCKET = 'example-invoice-bucket';
const KEY = storageKeyFor('6f1c2c1e-6c1a-4a8e-9a43-1f0d6f2a9b10', 'pdf');

const storage = (kmsKeyId?: string) =>
  new S3DocumentStorage(new S3Client(FAKE_AWS), {
    bucket: BUCKET,
    ...(kmsKeyId === undefined ? {} : { kmsKeyId }),
  });

const body = (bytes: Uint8Array) =>
  ({ transformToByteArray: () => Promise.resolve(bytes) }) as unknown as NonNullable<
    GetObjectCommandOutput['Body']
  >;

beforeEach(() => {
  s3Mock.reset();
});

describe('S3DocumentStorage.put', () => {
  it('uploads with server-generated key, content type, checksum, metadata and no-overwrite guard', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const content = pdfBytes();
    const sha256Hex = createHash('sha256').update(content).digest('hex');
    await storage().put(KEY, content, {
      contentType: 'application/pdf',
      sha256Hex,
      metadata: { 'document-id': 'abc' },
    });

    const input = s3Mock.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(input).toMatchObject({
      Bucket: BUCKET,
      Key: KEY,
      ContentType: 'application/pdf',
      ContentLength: content.byteLength,
      ChecksumSHA256: createHash('sha256').update(content).digest('base64'),
      Metadata: { 'document-id': 'abc' },
      IfNoneMatch: '*',
    });
    expect(input?.Key).toMatch(/^documents\/[0-9a-f-]{36}\/original\.pdf$/);
    expect(input?.ServerSideEncryption).toBeUndefined();
  });

  it('allows overwrite when requested and applies KMS encryption when configured', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await storage('alias/example').put('documents/x/extraction.json', new Uint8Array([1]), {
      contentType: 'application/json',
      overwrite: true,
    });
    const input = s3Mock.commandCalls(PutObjectCommand)[0]?.args[0].input;
    expect(input?.IfNoneMatch).toBeUndefined();
    expect(input).toMatchObject({ ServerSideEncryption: 'aws:kms', SSEKMSKeyId: 'alias/example' });
  });

  it.each([
    ['AccessDenied', 403, false],
    ['NoSuchBucket', 404, false],
    ['PreconditionFailed', 412, false],
    ['SlowDown', 503, true],
    ['InternalError', 500, true],
  ])('maps %s to a sanitised error (retryable: %s)', async (name, status, retryable) => {
    s3Mock.on(PutObjectCommand).rejects(awsError(name, status, `secret detail about ${BUCKET}`));
    const error = await storage()
      .put(KEY, pdfBytes(), { contentType: 'application/pdf' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ExternalServiceError);
    const ese = error as ExternalServiceError;
    expect(ese.message).toBe('s3 PutObject failed');
    expect(ese.message).not.toContain(BUCKET);
    expect(ese.cause).toBeUndefined();
    expect(ese.details).toMatchObject({
      awsErrorName: name,
      retryable,
      httpStatusCode: status,
      awsRequestId: 'req-123',
    });
  });
});

describe('S3DocumentStorage.get', () => {
  it('returns the object bytes', async () => {
    s3Mock.on(GetObjectCommand, { Bucket: BUCKET, Key: KEY }).resolves({
      Body: body(new Uint8Array([1, 2, 3])),
    });
    expect(await storage().get(KEY)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('returns undefined for a missing object', async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError('NoSuchKey', 404));
    expect(await storage().get(KEY)).toBeUndefined();
  });

  it('fails on a response without a body', async () => {
    s3Mock.on(GetObjectCommand).resolves({});
    await expect(storage().get(KEY)).rejects.toThrow('s3 GetObject returned no body');
  });

  it('maps throttling to a retryable error', async () => {
    s3Mock.on(GetObjectCommand).rejects(awsError('SlowDown', 503));
    const error = (await storage()
      .get(KEY)
      .catch((e: unknown) => e)) as ExternalServiceError;
    expect(error.details).toMatchObject({ retryable: true, operation: 'GetObject' });
  });
});

describe('M2 — ambiguous PutObject success (412 after a lost response)', () => {
  const content = pdfBytes();
  const sha256Hex = createHash('sha256').update(content).digest('hex');
  const checksum = createHash('sha256').update(content).digest('base64');
  const DOC_ID = '6f1c2c1e-6c1a-4a8e-9a43-1f0d6f2a9b10';
  const put = () =>
    storage().put(KEY, content, {
      contentType: 'application/pdf',
      sha256Hex,
      metadata: { 'document-id': DOC_ID },
    });

  beforeEach(() => {
    s3Mock.on(PutObjectCommand).rejects(awsError('PreconditionFailed', 412));
  });

  it('treats the write as successful when the existing object matches id and checksum', async () => {
    s3Mock
      .on(HeadObjectCommand)
      .resolves({ Metadata: { 'document-id': DOC_ID }, ChecksumSHA256: checksum });
    await expect(put()).resolves.toBeUndefined();
    expect(s3Mock.commandCalls(HeadObjectCommand)[0]?.args[0].input).toEqual({
      Bucket: BUCKET,
      Key: KEY,
      ChecksumMode: 'ENABLED',
    });
  });

  it.each([
    ['a different document id', { Metadata: { 'document-id': 'other' }, ChecksumSHA256: checksum }],
    ['a different checksum', { Metadata: { 'document-id': DOC_ID }, ChecksumSHA256: 'AAAA' }],
    ['no checksum', { Metadata: { 'document-id': DOC_ID } }],
    ['no metadata', { ChecksumSHA256: checksum }],
  ])('rejects an existing object with %s', async (_label, head) => {
    s3Mock.on(HeadObjectCommand).resolves(head);
    const error = (await put().catch((e: unknown) => e)) as ExternalServiceError;
    expect(error.details).toMatchObject({ awsErrorName: 'PreconditionFailed', retryable: false });
  });

  it('rejects when HeadObject itself fails', async () => {
    s3Mock.on(HeadObjectCommand).rejects(awsError('AccessDenied', 403));
    await expect(put()).rejects.toThrow('s3 PutObject failed');
  });

  it('cannot verify without an expected checksum and does not call HeadObject', async () => {
    await expect(
      storage().put(KEY, content, {
        contentType: 'application/pdf',
        metadata: { 'document-id': DOC_ID },
      }),
    ).rejects.toThrow('s3 PutObject failed');
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });

  it('does not attempt verification for other errors', async () => {
    s3Mock.on(PutObjectCommand).rejects(awsError('AccessDenied', 403));
    await expect(put()).rejects.toThrow('s3 PutObject failed');
    expect(s3Mock.commandCalls(HeadObjectCommand)).toHaveLength(0);
  });
});
