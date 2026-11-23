import type { DeterministicFailureCode } from '../../domain/document.js';
import { ExternalServiceError } from '../../domain/errors.js';

/** AWS service error names that indicate a transient condition. */
const RETRYABLE_ERROR_NAMES = new Set([
  'ThrottlingException',
  'Throttling',
  'TooManyRequestsException',
  'ProvisionedThroughputExceededException',
  'LimitExceededException',
  'InternalServerError',
  'InternalError',
  'ServiceUnavailable',
  'SlowDown',
  'RequestTimeout',
  'RequestTimeoutException',
  // S3: a concurrent conditional write on the same key; safe to retry later.
  'ConditionalRequestConflict',
  // AWS SDK / Smithy client-side timeouts.
  'TimeoutError',
]);

/**
 * Node.js network error codes that indicate a transient connectivity problem.
 * Explicit allowlist: unknown codes are NOT assumed to be transient.
 * ENOTFOUND is deliberately excluded (usually a misconfigured endpoint/region).
 */
const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** Permanent failures: retrying will not help. Takes precedence over every other rule. */
const PERMANENT_ERROR_NAMES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'ExpiredToken',
  'NoSuchBucket',
  'PreconditionFailed',
  'InvalidS3ObjectException',
  'UnsupportedDocumentException',
  'BadDocumentException',
  'DocumentTooLargeException',
  'InvalidParameterException',
  'InvalidJobIdException',
  'IdempotentParameterMismatchException',
  'InvalidKMSKeyException',
]);

/** Document-specific failures that recur on every attempt for the same input. */
const DETERMINISTIC_FAILURES: Readonly<Record<string, DeterministicFailureCode>> = {
  DocumentTooLargeException: 'DOCUMENT_TOO_LARGE',
  UnsupportedDocumentException: 'UNSUPPORTED_DOCUMENT',
  BadDocumentException: 'BAD_DOCUMENT',
};

interface AwsErrorShape {
  readonly name?: unknown;
  readonly code?: unknown;
  readonly $retryable?: unknown;
  readonly $metadata?: { readonly httpStatusCode?: number; readonly requestId?: string };
}

const shapeOf = (error: unknown): AwsErrorShape | undefined =>
  typeof error === 'object' && error !== null ? error : undefined;

export function awsErrorName(error: unknown): string {
  const name = shapeOf(error)?.name;
  return typeof name === 'string' ? name : 'UnknownError';
}

function networkCode(error: unknown): string | undefined {
  const code = shapeOf(error)?.code;
  return typeof code === 'string' && RETRYABLE_NETWORK_CODES.has(code) ? code : undefined;
}

export function isRetryableAwsError(error: unknown): boolean {
  const shape = shapeOf(error);
  const name = awsErrorName(error);
  if (PERMANENT_ERROR_NAMES.has(name)) return false;
  if (RETRYABLE_ERROR_NAMES.has(name)) return true;
  if (networkCode(error) !== undefined) return true;
  // The SDK marks errors it considers transient (e.g. throttling) with $retryable.
  if (shape?.$retryable !== undefined && shape.$retryable !== false) return true;
  const status = shape?.$metadata?.httpStatusCode;
  return status !== undefined && status >= 500;
}

/**
 * Converts an AWS SDK error into a sanitised ExternalServiceError. The original
 * error is deliberately NOT attached as `cause`: AWS messages can contain
 * bucket names, keys or account details. Only the error name, network code,
 * HTTP status and request ID are kept for diagnosis.
 */
export function toExternalServiceError(
  error: unknown,
  context: { readonly provider: 's3' | 'textract'; readonly operation: string },
): ExternalServiceError {
  const metadata = shapeOf(error)?.$metadata;
  const name = awsErrorName(error);
  const code = networkCode(error);
  const failureCode = DETERMINISTIC_FAILURES[name];
  return new ExternalServiceError(`${context.provider} ${context.operation} failed`, {
    provider: context.provider,
    operation: context.operation,
    retryable: isRetryableAwsError(error),
    awsErrorName: name,
    ...(code === undefined ? {} : { networkCode: code }),
    ...(failureCode === undefined ? {} : { failureCode }),
    ...(metadata?.httpStatusCode === undefined ? {} : { httpStatusCode: metadata.httpStatusCode }),
    ...(metadata?.requestId === undefined ? {} : { awsRequestId: metadata.requestId }),
  });
}
