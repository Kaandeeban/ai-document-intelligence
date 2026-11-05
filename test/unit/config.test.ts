import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config/env.js';

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig({})).toMatchObject({
      nodeEnv: 'development',
      port: 3000,
      maxUploadBytes: 10 * 1024 * 1024,
      apiDocsEnabled: true,
    });
  });

  it('coerces numeric and boolean values', () => {
    const config = loadConfig({
      PORT: '8080',
      MAX_UPLOAD_BYTES: '2048',
      API_DOCS_ENABLED: 'false',
    });
    expect(config).toMatchObject({ port: 8080, maxUploadBytes: 2048, apiDocsEnabled: false });
  });

  it.each([
    ['non-numeric port', { PORT: 'abc' }],
    ['port out of range', { PORT: '70000' }],
    ['upload limit above hard cap', { MAX_UPLOAD_BYTES: String(100 * 1024 * 1024) }],
    ['unknown log level', { LOG_LEVEL: 'verbose' }],
  ])('fails fast on %s', (_label, env) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });
});
