/**
 * Domain errors carry a stable machine-readable code. Mapping codes to HTTP
 * status codes is the API layer's responsibility, not the domain's.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'EMPTY_FILE'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'DOCUMENT_NOT_FOUND'
  | 'INVALID_STATUS_TRANSITION'
  | 'EXTERNAL_SERVICE_ERROR';

export type ErrorDetails = Readonly<Record<string, unknown>>;

export abstract class DomainError extends Error {
  abstract readonly code: ErrorCode;
  readonly details: ErrorDetails | undefined;

  constructor(message: string, details?: ErrorDetails, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.details = details;
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
}

export class EmptyFileError extends DomainError {
  readonly code = 'EMPTY_FILE';
}

export class FileTooLargeError extends DomainError {
  readonly code = 'FILE_TOO_LARGE';
}

export class UnsupportedFileTypeError extends DomainError {
  readonly code = 'UNSUPPORTED_FILE_TYPE';
}

export class DocumentNotFoundError extends DomainError {
  readonly code = 'DOCUMENT_NOT_FOUND';
}

export class InvalidStatusTransitionError extends DomainError {
  readonly code = 'INVALID_STATUS_TRANSITION';
}

export class ExternalServiceError extends DomainError {
  readonly code = 'EXTERNAL_SERVICE_ERROR';
}
