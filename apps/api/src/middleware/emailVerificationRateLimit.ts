import { createHmac } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/pool';
import { env } from '../config/env';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

type RateLimitScope = 'request-ip-hour' | 'request-email-hour' | 'request-email-day' | 'confirm-ip-hour' | 'confirm-token-hour';
type RateLimitWindow = '1 hour' | '24 hours';

const REQUEST_IP_LIMIT = 10;
const REQUEST_EMAIL_HOUR_LIMIT = 3;
const REQUEST_EMAIL_DAY_LIMIT = 10;
const CONFIRM_IP_LIMIT = 30;
const CONFIRM_TOKEN_LIMIT = 10;
const CLEANUP_INTERVAL_MS = 60_000;
const CLEANUP_BATCH_SIZE = 2_000;

function rateLimitKey(scope: RateLimitScope, value: string): string {
  const masterKey = env.EMAIL_DELIVERY_ENCRYPTION_KEY
    ? Buffer.from(env.EMAIL_DELIVERY_ENCRYPTION_KEY, 'base64')
    : Buffer.from(env.JWT_SECRET, 'utf8');
  const hmacKey = createHmac('sha256', masterKey)
    .update('verification-rate-limit-key-derivation-v1')
    .digest();
  return createHmac('sha256', hmacKey)
    .update(`verification-rate-limit-v1\0${scope}\0${value}`)
    .digest('hex');
}

async function consume(scope: RateLimitScope, value: string, window: RateLimitWindow): Promise<number> {
  const keyHash = rateLimitKey(scope, value);
  const { rows } = await pool.query<{ request_count: number }>(
    `WITH clock_value AS (
       SELECT clock_timestamp() AS value
     ), bucket AS (
       SELECT CASE WHEN $2::interval = INTERVAL '1 hour'
         THEN date_trunc('hour', clock_value.value AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
         ELSE date_trunc('day', clock_value.value AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
       END AS starts_at
       FROM clock_value
     )
     INSERT INTO email_verification_rate_limits AS current_limit
       (key_hash, window_started_at, request_count, expires_at)
     SELECT $1, bucket.starts_at, 1, bucket.starts_at + $2::interval + INTERVAL '1 day'
     FROM bucket
     ON CONFLICT (key_hash) DO UPDATE
       SET request_count = CASE
             WHEN current_limit.window_started_at = EXCLUDED.window_started_at
               THEN current_limit.request_count + 1
             ELSE 1
           END,
           window_started_at = EXCLUDED.window_started_at,
           expires_at = EXCLUDED.expires_at
     RETURNING request_count`,
    [keyHash, window],
  );
  if (rows.length !== 1) throw new Error('Shared verification rate limit returned an unexpected row count');
  return rows[0].request_count;
}

function stringField(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emailFromRequest(req: Request): string | null {
  if (!isRecord(req.body)) return null;
  const email = stringField(req.body.email);
  if (!email || email.length > 320 || !email.includes('@')) return null;
  return email.trim().toLowerCase();
}

function tokenFromRequest(req: Request): string | null {
  if (!isRecord(req.body)) return null;
  return stringField(req.body.token);
}

function clientAddress(req: Request): string {
  return req.ip || req.socket.remoteAddress || 'unknown';
}

function unavailableError(): AppError {
  return new AppError('EMAIL_DELIVERY_UNAVAILABLE', 'Verification is temporarily unavailable', 503);
}

export async function verificationRequestRateLimit(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ipCount = await consume('request-ip-hour', clientAddress(req), '1 hour');
    if (ipCount > REQUEST_IP_LIMIT) {
      next(new AppError('RATE_LIMITED', 'Too many verification requests. Please try again later.', 429));
      return;
    }

    const email = emailFromRequest(req);
    if (email) {
      const [hourCount, dayCount] = await Promise.all([
        consume('request-email-hour', email, '1 hour'),
        consume('request-email-day', email, '24 hours'),
      ]);
      if (hourCount > REQUEST_EMAIL_HOUR_LIMIT || dayCount > REQUEST_EMAIL_DAY_LIMIT) {
        req.emailVerificationSuppressed = true;
      }
    }
    next();
  } catch {
    logger.warn('Shared verification rate limit unavailable', { event: 'verification_rate_limit_unavailable' });
    next(unavailableError());
  }
}

export async function verificationConfirmationRateLimit(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ipCount = await consume('confirm-ip-hour', clientAddress(req), '1 hour');
    if (ipCount > CONFIRM_IP_LIMIT) {
      next(new AppError('RATE_LIMITED', 'Too many verification attempts. Please try again later.', 429));
      return;
    }
    const token = tokenFromRequest(req);
    if (token) {
      const tokenCount = await consume('confirm-token-hour', token, '1 hour');
      if (tokenCount > CONFIRM_TOKEN_LIMIT) {
        next(new AppError('TOKEN_INVALID', 'This verification link is invalid or expired', 400));
        return;
      }
    }
    next();
  } catch {
    logger.warn('Shared verification rate limit unavailable', { event: 'verification_rate_limit_unavailable' });
    next(unavailableError());
  }
}

export async function cleanupExpiredVerificationRateLimits(): Promise<number> {
  const { rows } = await pool.query<{ key_hash: string }>(
    `WITH expired AS (
       SELECT key_hash
       FROM email_verification_rate_limits
       WHERE expires_at <= clock_timestamp()
       ORDER BY expires_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     DELETE FROM email_verification_rate_limits AS rate_limit
     USING expired
     WHERE rate_limit.key_hash = expired.key_hash
     RETURNING rate_limit.key_hash`,
    [CLEANUP_BATCH_SIZE],
  );
  return rows.length;
}

let cleanupRunning = false;

export function startVerificationRateLimitCleanup(): void {
  if (cleanupRunning) return;
  cleanupRunning = true;
  const cleanup = async () => {
    try {
      await cleanupExpiredVerificationRateLimits();
    } catch {
      logger.warn('Verification rate limit cleanup failed', { event: 'verification_rate_limit_cleanup_failed' });
    }
  };
  void cleanup();
  setInterval(() => void cleanup(), CLEANUP_INTERVAL_MS);
}

export const verificationRateLimits = {
  requestIpPerHour: REQUEST_IP_LIMIT,
  requestRecipientPerHour: REQUEST_EMAIL_HOUR_LIMIT,
  requestRecipientPerDay: REQUEST_EMAIL_DAY_LIMIT,
  confirmationIpPerHour: CONFIRM_IP_LIMIT,
  confirmationTokenPerHour: CONFIRM_TOKEN_LIMIT,
};
