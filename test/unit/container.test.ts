import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { createAdapters, createApplication } from '../../src/container.js';
import { S3DocumentStorage } from '../../src/infrastructure/aws/s3-document-storage.js';
import { TextractTextExtractor } from '../../src/infrastructure/aws/textract-text-extractor.js';
import {
  InMemoryDocumentStorage,
  StubTextExtractor,
} from '../../src/infrastructure/local-adapters.js';
import { silentLogger } from '../support/services.js';

const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((close) => {
    close();
  });
});

describe('composition root', () => {
  it('wires local adapters by default and creates no AWS clients', () => {
    const { adapters, aws } = createAdapters(loadConfig({}));
    expect(adapters.storage).toBeInstanceOf(InMemoryDocumentStorage);
    expect(adapters.extractor).toBeInstanceOf(StubTextExtractor);
    expect(aws).toBeUndefined();
  });

  it('wires S3 and Textract adapters from configuration (no network calls)', async () => {
    const config = loadConfig({
      STORAGE_DRIVER: 's3',
      EXTRACTOR_DRIVER: 'textract',
      AWS_REGION: 'eu-west-2',
      AWS_S3_BUCKET: 'example-invoice-bucket',
      AWS_MAX_ATTEMPTS: '4',
    });
    const { adapters, aws } = createAdapters(config);
    expect(aws).toBeDefined();
    if (!aws) return;
    closers.push(() => {
      aws.destroy();
    });
    expect(adapters.storage).toBeInstanceOf(S3DocumentStorage);
    expect(adapters.extractor).toBeInstanceOf(TextractTextExtractor);
    expect(await aws.s3.config.region()).toBe('eu-west-2');
    expect(await aws.textract.config.maxAttempts()).toBe(4);
  });

  it('supports S3 storage with the local stub extractor', () => {
    const { adapters, aws } = createAdapters(
      loadConfig({
        STORAGE_DRIVER: 's3',
        AWS_REGION: 'eu-west-2',
        AWS_S3_BUCKET: 'example-invoice-bucket',
      }),
    );
    if (aws)
      closers.push(() => {
        aws.destroy();
      });
    expect(adapters.storage).toBeInstanceOf(S3DocumentStorage);
    expect(adapters.extractor).toBeInstanceOf(StubTextExtractor);
  });

  it('lets explicit overrides replace configured adapters', () => {
    const storage = new InMemoryDocumentStorage();
    const app = createApplication(loadConfig({}), silentLogger(), { storage });
    closers.push(() => {
      void app.close();
    });
    expect(app.adapters.storage).toBe(storage);
  });
});
