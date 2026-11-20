export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'SESSION_REVOKED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'EMAIL_DELIVERY_UNAVAILABLE'
  | 'PAYLOAD_TOO_LARGE'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  public readonly code: ErrorCode;
  public readonly statusCode: number;
  public readonly details?: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    statusCode: number,
    details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;

    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export function notFound(resource: string): AppError {
  return new AppError('NOT_FOUND', `${resource} not found`, 404);
}

export function conflict(message: string): AppError {
  return new AppError('CONFLICT', message, 409);
}

export function forbidden(message = 'Insufficient permissions'): AppError {
  return new AppError('FORBIDDEN', message, 403);
}

export function unauthenticated(message = 'Authentication required'): AppError {
  return new AppError('AUTHENTICATION_REQUIRED', message, 401);
}
