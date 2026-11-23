import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type PutObjectCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { DocumentStorage, PutObjectOptions } from '../../application/ports/index.js';
import { ExternalServiceError } from '../../domain/errors.js';
import { awsErrorName, toExternalServiceError } from './aws-error.js';

export interface S3DocumentStorageOptions {
  readonly bucket: string;
  /** When set, objects are encrypted with this KMS key; otherwise the bucket default applies. */
  readonly kmsKeyId?: string;
}

/**
 * S3-backed document storage. Keys are server-generated (see storageKeyFor);
 * user-supplied filenames never reach S3. Content is never logged.
 */
export class S3DocumentStorage implements DocumentStorage {
  constructor(
    private readonly client: S3Client,
    private readonly options: S3DocumentStorageOptions,
  ) {}

  async put(key: string, content: Uint8Array, options: PutObjectOptions): Promise<void> {
    const { kmsKeyId } = this.options;
    const input: PutObjectCommandInput = {
      Bucket: this.options.bucket,
      Key: key,
      Body: content,
      ContentType: options.contentType,
      ContentLength: content.byteLength,
      ...(options.sha256Hex === undefined
        ? {}
        : { ChecksumSHA256: Buffer.from(options.sha256Hex, 'hex').toString('base64') }),
      ...(options.metadata === undefined ? {} : { Metadata: { ...options.metadata } }),
      // Conditional write: never silently replace an existing object.
      ...(options.overwrite === true ? {} : { IfNoneMatch: '*' }),
      ...(kmsKeyId === undefined
        ? {}
        : { ServerSideEncryption: 'aws:kms' as const, SSEKMSKeyId: kmsKeyId }),
    };
    try {
      await this.client.send(new PutObjectCommand(input));
    } catch (error) {
      // A 412 on a no-overwrite write is ambiguous: another writer got there
      // first, OR our own earlier attempt succeeded and the SDK retried after a
      // lost response. Only the latter is a success, and only if verified.
      if (
        options.overwrite !== true &&
        awsErrorName(error) === 'PreconditionFailed' &&
        (await this.isSameObject(key, input.ChecksumSHA256, options.metadata?.['document-id']))
      ) {
        return;
      }
      throw toExternalServiceError(error, { provider: 's3', operation: 'PutObject' });
    }
  }

  /**
   * Verifies identity (document-id metadata) AND integrity (SHA-256) of an
   * existing object. Without both expected values nothing can be verified.
   * Any HeadObject failure counts as "not verified".
   */
  private async isSameObject(
    key: string,
    expectedChecksum: string | undefined,
    expectedDocumentId: string | undefined,
  ): Promise<boolean> {
    if (expectedChecksum === undefined || expectedDocumentId === undefined) return false;
    try {
      const head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.options.bucket, Key: key, ChecksumMode: 'ENABLED' }),
      );
      return (
        head.Metadata?.['document-id'] === expectedDocumentId &&
        head.ChecksumSHA256 === expectedChecksum
      );
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const output = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
      );
      if (!output.Body) {
        throw new ExternalServiceError('s3 GetObject returned no body', {
          provider: 's3',
          operation: 'GetObject',
          retryable: false,
        });
      }
      return await output.Body.transformToByteArray();
    } catch (error) {
      if (error instanceof ExternalServiceError) throw error;
      if (awsErrorName(error) === 'NoSuchKey') return undefined;
      throw toExternalServiceError(error, { provider: 's3', operation: 'GetObject' });
    }
  }
}
