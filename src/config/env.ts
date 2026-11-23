import { z } from 'zod';

const MIB = 1024 * 1024;

const intInRange = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
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

    // Adapter selection. Defaults keep everything local with no AWS access.
    STORAGE_DRIVER: z.enum(['memory', 's3']).default('memory'),
    EXTRACTOR_DRIVER: z.enum(['stub', 'textract']).default('stub'),

    // AWS. Credentials always come from the standard AWS credential provider chain.
    AWS_REGION: z
      .string()
      .regex(/^[a-z]{2}(-[a-z]+)+-\d{1,2}$/, 'Must be an AWS region such as eu-west-2')
      .optional(),
    AWS_S3_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Must be a valid S3 bucket name')
      .optional(),
    AWS_S3_KMS_KEY_ID: z.string().min(1).max(2048).optional(),
    AWS_MAX_ATTEMPTS: intInRange(1, 10, 3),
    AWS_CONNECTION_TIMEOUT_MS: intInRange(100, 60_000, 3_000),
    AWS_REQUEST_TIMEOUT_MS: intInRange(100, 120_000, 10_000),

    // Asynchronous (PDF) OCR completion tracking.
    TEXTRACT_POLL_INITIAL_DELAY_MS: intInRange(100, 60_000, 2_000),
    TEXTRACT_POLL_MAX_DELAY_MS: intInRange(100, 300_000, 15_000),
    TEXTRACT_JOB_TIMEOUT_MS: intInRange(1_000, 3_600_000, 300_000),
    TEXTRACT_MAX_RESULT_PAGES: intInRange(1, 1_000, 100),
    TEXTRACT_MAX_PENDING_JOBS: intInRange(1, 10_000, 50),
  })
  .superRefine((env, ctx) => {
    // Fail closed: billable OCR must not be reachable without authentication,
    // which arrives in Milestone 5. There is intentionally no override flag.
    if (env.NODE_ENV === 'production' && env.EXTRACTOR_DRIVER === 'textract') {
      ctx.addIssue({
        code: 'custom',
        path: ['EXTRACTOR_DRIVER'],
        message:
          'EXTRACTOR_DRIVER=textract is not allowed with NODE_ENV=production until API authentication is implemented',
      });
    }
    const usesAws = env.STORAGE_DRIVER === 's3' || env.EXTRACTOR_DRIVER === 'textract';
    if (usesAws && env.AWS_REGION === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['AWS_REGION'],
        message: 'Required when AWS adapters are enabled',
      });
    }
    if (env.STORAGE_DRIVER === 's3' && env.AWS_S3_BUCKET === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['AWS_S3_BUCKET'],
        message: 'Required when STORAGE_DRIVER=s3',
      });
    }
    if (env.EXTRACTOR_DRIVER === 'textract' && env.STORAGE_DRIVER !== 's3') {
      ctx.addIssue({
        code: 'custom',
        path: ['EXTRACTOR_DRIVER'],
        message:
          'EXTRACTOR_DRIVER=textract requires STORAGE_DRIVER=s3 (Textract reads documents from S3)',
      });
    }
    if (env.TEXTRACT_POLL_INITIAL_DELAY_MS > env.TEXTRACT_POLL_MAX_DELAY_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['TEXTRACT_POLL_INITIAL_DELAY_MS'],
        message: 'Must not exceed TEXTRACT_POLL_MAX_DELAY_MS',
      });
    }
  });

export type LogLevel = z.infer<typeof envSchema>['LOG_LEVEL'];

export type StorageConfig =
  | { readonly driver: 'memory' }
  | { readonly driver: 's3'; readonly bucket: string; readonly kmsKeyId?: string };

export interface ExtractionConfig {
  readonly driver: 'stub' | 'textract';
  readonly pollInitialDelayMs: number;
  readonly pollMaxDelayMs: number;
  readonly jobTimeoutMs: number;
  readonly maxResultPages: number;
  readonly maxPendingJobs: number;
}

export interface AwsConfig {
  /** Present whenever an AWS adapter is enabled (enforced at startup). */
  readonly region?: string;
  readonly maxAttempts: number;
  readonly connectionTimeoutMs: number;
  readonly requestTimeoutMs: number;
}

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly maxUploadBytes: number;
  readonly requestTimeoutMs: number;
  readonly apiDocsEnabled: boolean;
  readonly storage: StorageConfig;
  readonly extraction: ExtractionConfig;
  readonly aws: AwsConfig;
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
  const storage: StorageConfig =
    e.STORAGE_DRIVER === 's3' && e.AWS_S3_BUCKET !== undefined
      ? {
          driver: 's3',
          bucket: e.AWS_S3_BUCKET,
          ...(e.AWS_S3_KMS_KEY_ID === undefined ? {} : { kmsKeyId: e.AWS_S3_KMS_KEY_ID }),
        }
      : { driver: 'memory' };
  return {
    nodeEnv: e.NODE_ENV,
    host: e.HOST,
    port: e.PORT,
    logLevel: e.LOG_LEVEL,
    maxUploadBytes: e.MAX_UPLOAD_BYTES,
    requestTimeoutMs: e.REQUEST_TIMEOUT_MS,
    apiDocsEnabled: e.API_DOCS_ENABLED,
    storage,
    extraction: {
      driver: e.EXTRACTOR_DRIVER,
      pollInitialDelayMs: e.TEXTRACT_POLL_INITIAL_DELAY_MS,
      pollMaxDelayMs: e.TEXTRACT_POLL_MAX_DELAY_MS,
      jobTimeoutMs: e.TEXTRACT_JOB_TIMEOUT_MS,
      maxResultPages: e.TEXTRACT_MAX_RESULT_PAGES,
      maxPendingJobs: e.TEXTRACT_MAX_PENDING_JOBS,
    },
    aws: {
      ...(e.AWS_REGION === undefined ? {} : { region: e.AWS_REGION }),
      maxAttempts: e.AWS_MAX_ATTEMPTS,
      connectionTimeoutMs: e.AWS_CONNECTION_TIMEOUT_MS,
      requestTimeoutMs: e.AWS_REQUEST_TIMEOUT_MS,
    },
  };
}
