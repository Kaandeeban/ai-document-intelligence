import { describe, expect, it } from 'vitest';
import {
  isRetryableAwsError,
  toExternalServiceError,
} from '../../../src/infrastructure/aws/aws-error.js';
import { awsError } from './aws-test-utils.js';

const networkError = (code: string) => Object.assign(new Error(`socket error ${code}`), { code });

describe('AWS error classification', () => {
  it('treats unknown 5xx errors as retryable and unknown 4xx as permanent', () => {
    expect(isRetryableAwsError(awsError('SomethingNew', 502))).toBe(true);
    expect(isRetryableAwsError(awsError('SomethingNew', 400))).toBe(false);
  });

  it('lets explicit permanent names win over a 5xx status', () => {
    expect(isRetryableAwsError(awsError('AccessDenied', 500))).toBe(false);
  });

  it('handles timeouts and non-Error values', () => {
    expect(isRetryableAwsError(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isRetryableAwsError('boom')).toBe(false);
    expect(isRetryableAwsError(null)).toBe(false);
    expect(
      toExternalServiceError(undefined, { provider: 's3', operation: 'X' }).details,
    ).toMatchObject({ awsErrorName: 'UnknownError', retryable: false });
  });
});

describe('H1 — transient network errors (explicit allowlist)', () => {
  it.each([
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
  ])('classifies %s (no HTTP status) as retryable', (code) => {
    expect(isRetryableAwsError(networkError(code))).toBe(true);
    expect(
      toExternalServiceError(networkError(code), { provider: 'textract', operation: 'X' }).details,
    ).toMatchObject({ retryable: true, networkCode: code });
  });

  it.each(['ENOTFOUND', 'EACCES', 'ERR_SOMETHING_NEW'])(
    'does NOT assume unknown or configuration codes like %s are transient',
    (code) => {
      expect(isRetryableAwsError(networkError(code))).toBe(false);
    },
  );

  it('does not treat a plain Error without status or code as retryable', () => {
    expect(isRetryableAwsError(new Error('mystery'))).toBe(false);
  });

  it('honours the SDK $retryable marker', () => {
    const throttled = Object.assign(new Error('x'), {
      name: 'SomeNewThrottle',
      $retryable: { throttling: true },
      $metadata: { httpStatusCode: 400 },
    });
    expect(isRetryableAwsError(throttled)).toBe(true);
  });

  it('classifies S3 ConditionalRequestConflict as retryable', () => {
    expect(isRetryableAwsError(awsError('ConditionalRequestConflict', 409))).toBe(true);
  });

  it('never logs the network error message', () => {
    const ese = toExternalServiceError(networkError('ECONNRESET'), {
      provider: 's3',
      operation: 'PutObject',
    });
    expect(JSON.stringify(ese.details)).not.toContain('socket error');
    expect(ese.cause).toBeUndefined();
  });
});

describe('L5 — deterministic document failures', () => {
  it.each([
    ['DocumentTooLargeException', 'DOCUMENT_TOO_LARGE'],
    ['UnsupportedDocumentException', 'UNSUPPORTED_DOCUMENT'],
    ['BadDocumentException', 'BAD_DOCUMENT'],
  ])('maps %s to failure code %s and marks it permanent', (name, failureCode) => {
    expect(
      toExternalServiceError(awsError(name, 400), { provider: 'textract', operation: 'X' }).details,
    ).toMatchObject({ failureCode, retryable: false });
  });
});
