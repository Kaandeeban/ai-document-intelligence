import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import { DomainError, type ErrorCode } from '../domain/errors.js';

/** HTTP-level error raised by the API layer itself (e.g. wrong content type). */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

const DOMAIN_STATUS: Readonly<Record<ErrorCode, number>> = {
  VALIDATION_ERROR: 400,
  EMPTY_FILE: 400,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  DOCUMENT_NOT_FOUND: 404,
  INVALID_STATUS_TRANSITION: 409,
  EXTERNAL_SERVICE_ERROR: 502,
};

const TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  404: 'Not Found',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

/** RFC 9457 problem details, extended with a stable code and the request ID. */
export interface ProblemDetails {
  type: 'about:blank';
  title: string;
  status: number;
  detail: string;
  code: string;
  instance: string;
  requestId: string;
  details?: Readonly<Record<string, unknown>>;
  errors?: readonly { path: string; message: string }[];
}

function toProblem(error: unknown, request: FastifyRequest): ProblemDetails {
  const base = { type: 'about:blank' as const, instance: request.url, requestId: request.id };
  const problem = (status: number, code: string, detail: string): ProblemDetails => ({
    ...base,
    status,
    code,
    detail,
    title: TITLES[status] ?? 'Error',
  });

  if (error instanceof DomainError) {
    const result = problem(DOMAIN_STATUS[error.code], error.code, error.message);
    // External-service details may leak internals; only expose them for client errors.
    if (error.details && result.status < 500) result.details = error.details;
    return result;
  }
  if (error instanceof HttpError) {
    return problem(error.statusCode, error.code, error.message);
  }
  if (hasZodFastifySchemaValidationErrors(error)) {
    return {
      ...problem(400, 'VALIDATION_ERROR', 'Request validation failed'),
      errors: error.validation.map((issue) => ({
        path: issue.instancePath,
        message: issue.message ?? 'Invalid value',
      })),
    };
  }
  const fastifyError = error as Partial<FastifyError>;
  if (fastifyError.code === 'FST_FILES_LIMIT') {
    return problem(400, 'VALIDATION_ERROR', 'Exactly one file must be uploaded per request');
  }
  if (fastifyError.code === 'FST_REQ_FILE_TOO_LARGE') {
    return problem(413, 'FILE_TOO_LARGE', 'File exceeds the maximum upload size');
  }
  const status = fastifyError.statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    return problem(
      status,
      fastifyError.code ?? 'REQUEST_ERROR',
      fastifyError.message ?? 'Request error',
    );
  }
  return problem(500, 'INTERNAL_ERROR', 'An unexpected error occurred');
}

export function errorHandler(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const problem = toProblem(error, request);
  if (problem.status >= 500) {
    request.log.error({ err: error }, 'Request failed');
  } else {
    request.log.info({ code: problem.code, status: problem.status }, 'Request rejected');
  }
  return reply.code(problem.status).type('application/problem+json').send(problem);
}

export function notFoundHandler(request: FastifyRequest, reply: FastifyReply): FastifyReply {
  return reply
    .code(404)
    .type('application/problem+json')
    .send({
      type: 'about:blank',
      title: 'Not Found',
      status: 404,
      detail: `Route ${request.method} ${request.url} not found`,
      code: 'ROUTE_NOT_FOUND',
      instance: request.url,
      requestId: request.id,
    } satisfies ProblemDetails);
}
