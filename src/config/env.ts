import { z } from 'zod';

const MIB = 1024 * 1024;

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MAX_UPLOAD_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .max(50 * MIB)
    .default(10 * MIB),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(300_000).default(30_000),
  API_DOCS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
});

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly maxUploadBytes: number;
  readonly requestTimeoutMs: number;
  readonly apiDocsEnabled: boolean;
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Parses and validates configuration. Throws ConfigError so the process fails fast at startup. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    throw new ConfigError(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  const e = result.data;
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    apiDocsEnabled: e.API_DOCS_ENABLED,
  };
}
