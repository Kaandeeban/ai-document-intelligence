/** Fake AWS errors and clients. Fake credentials guarantee no real AWS call is possible. */
export const FAKE_AWS = {
  region: 'eu-west-2',
  credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
  maxAttempts: 1,
} as const;

export function awsError(name: string, httpStatusCode: number, message = 'AWS error'): Error {
  return Object.assign(new Error(message), {
    name,
    $metadata: { httpStatusCode, requestId: 'req-123' },
  });
}
