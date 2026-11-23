import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';

const awsEnv = {
  STORAGE_DRIVER: 's3',
  EXTRACTOR_DRIVER: 'textract',
  AWS_REGION: 'eu-west-2',
  AWS_S3_BUCKET: 'example-invoice-bucket',
};

describe('loadConfig — adapter selection', () => {
  it('defaults to local adapters without any AWS settings', () => {
    const config = loadConfig({});
    expect(config.storage).toEqual({ driver: 'memory' });
    expect(config.extraction.driver).toBe('stub');
    expect(config.aws.region).toBeUndefined();
  });

  it('parses a complete AWS configuration', () => {
    const config = loadConfig({ ...awsEnv, AWS_S3_KMS_KEY_ID: 'alias/example' });
    expect(config.storage).toEqual({
      driver: 's3',
      bucket: 'example-invoice-bucket',
      kmsKeyId: 'alias/example',
    });
    expect(config.extraction).toMatchObject({
      driver: 'textract',
      pollInitialDelayMs: 2_000,
      jobTimeoutMs: 300_000,
    });
    expect(config.aws).toMatchObject({ region: 'eu-west-2', maxAttempts: 3 });
  });

  it.each([
    ['missing region for s3', { STORAGE_DRIVER: 's3', AWS_S3_BUCKET: 'example-bucket' }],
    ['missing bucket for s3', { STORAGE_DRIVER: 's3', AWS_REGION: 'eu-west-2' }],
    ['textract without s3', { EXTRACTOR_DRIVER: 'textract', AWS_REGION: 'eu-west-2' }],
    ['invalid region', { ...awsEnv, AWS_REGION: 'Europe' }],
    ['invalid bucket name', { ...awsEnv, AWS_S3_BUCKET: 'Bad_Bucket' }],
    ['unknown driver', { STORAGE_DRIVER: 'gcs' }],
    ['too many attempts', { AWS_MAX_ATTEMPTS: '50' }],
    ['initial delay above max', { TEXTRACT_POLL_INITIAL_DELAY_MS: '20000' }],
  ])('fails fast on %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});

describe('L8 — billable OCR is fail-closed in production', () => {
  it('refuses EXTRACTOR_DRIVER=textract with NODE_ENV=production', () => {
    expect(() => loadConfig({ ...awsEnv, NODE_ENV: 'production' })).toThrow(
      /not allowed with NODE_ENV=production/,
    );
  });

  it('has no override flag', () => {
    for (const flag of ['ALLOW_UNAUTHENTICATED_OCR', 'ALLOW_TEXTRACT_IN_PRODUCTION']) {
      expect(() => loadConfig({ ...awsEnv, NODE_ENV: 'production', [flag]: 'true' })).toThrow(
        ConfigError,
      );
    }
  });

  it('still allows production with local adapters or S3 storage only', () => {
    expect(loadConfig({ NODE_ENV: 'production' }).nodeEnv).toBe('production');
    expect(
      loadConfig({
        NODE_ENV: 'production',
        STORAGE_DRIVER: 's3',
        AWS_REGION: 'eu-west-2',
        AWS_S3_BUCKET: 'example-invoice-bucket',
      }).storage.driver,
    ).toBe('s3');
  });

  it('allows Textract outside production', () => {
    expect(loadConfig({ ...awsEnv, NODE_ENV: 'development' }).extraction.driver).toBe('textract');
  });
});
