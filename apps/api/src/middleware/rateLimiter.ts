import rateLimit from 'express-rate-limit';
import { AppError } from '../utils/errors';

// Strict rate limiter for authentication endpoints (10 requests per 15 minutes per IP)
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(
      new AppError(
        'RATE_LIMITED',
        'Too many requests. Please wait before trying again.',
        429,
      ),
    );
  },
});

// General rate limiter for API endpoints (200 requests per minute per IP)
export const generalRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 200,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, _res, next) => {
    next(
      new AppError(
        'RATE_LIMITED',
        'Too many requests. Please wait before trying again.',
        429,
      ),
    );
  },
});
