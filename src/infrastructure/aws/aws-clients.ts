import { S3Client } from '@aws-sdk/client-s3';
import { TextractClient } from '@aws-sdk/client-textract';
import type { AwsConfig } from '../../config/env.js';

export interface AwsClients {
  readonly s3: S3Client;
  readonly textract: TextractClient;
  destroy(): void;
}

/**
 * Builds AWS SDK v3 clients once per process. Credentials are resolved by the
 * SDK's default provider chain (environment, shared profile, SSO, container or
 * instance role); they are never read from application configuration.
 * Retries use the SDK's standard mode (exponential backoff with jitter) for
 * throttling, 5xx and network errors, bounded by AWS_MAX_ATTEMPTS.
 */
export function createAwsClients(config: AwsConfig): AwsClients {
  if (config.region === undefined) {
    throw new Error('AWS region is required to create AWS clients');
  }
  const common = {
    region: config.region,
    maxAttempts: config.maxAttempts,
    retryMode: 'standard',
    requestHandler: {
      connectionTimeout: config.connectionTimeoutMs,
      requestTimeout: config.requestTimeoutMs,
    },
  } as const;
  const s3 = new S3Client(common);
  const textract = new TextractClient(common);
  return {
    s3,
    textract,
    destroy: () => {
      s3.destroy();
      textract.destroy();
    },
  };
}
