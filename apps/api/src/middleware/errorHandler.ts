import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { env } from '../config/env';

function isBodyParserError(
  error: unknown,
  type: 'entity.parse.failed' | 'entity.too.large',
  statusCode: number,
): boolean {
  return typeof error === 'object'
    && error !== null
    && 'type' in error
    && error.type === type
    && 'status' in error
    && error.status === statusCode;
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (isBodyParserError(err, 'entity.parse.failed', 400)) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid JSON request body',
      },
    });
    return;
  }

  if (isBodyParserError(err, 'entity.too.large', 413)) {
    res.status(413).json({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body is too large',
      },
    });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: err.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error('Application error', {
        code: err.code,
        message: err.message,
        statusCode: err.statusCode,
      });
    } else {
      logger.warn('Request error', {
        code: err.code,
        message: err.message,
        statusCode: err.statusCode,
      });
    }

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        ...(err.details !== undefined &&
          (env.NODE_ENV !== 'production' || err.statusCode === 400)
          ? { details: err.details }
          : {}),
      },
    });
    return;
  }

  logger.error('Unexpected request error', {
    event: 'unexpected_request_error',
    method: req.method,
    route: typeof req.route?.path === 'string' ? req.route.path : undefined,
    statusCode: 500,
  });

  res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred',
    },
  });
}
