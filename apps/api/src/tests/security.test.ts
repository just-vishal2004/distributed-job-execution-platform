import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import { AppError } from '../utils/errors';
import { errorHandler } from '../middleware/errorHandler';
import { registerSchema } from '../modules/auth/auth.schemas';

describe('Security Controls', () => {
  describe('Rate Limiter', () => {
    let appWithRateLimit: express.Express;

    beforeEach(() => {
      appWithRateLimit = express();

      const testLimiter = rateLimit({
        windowMs: 60 * 1000,
        limit: 3,
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

      appWithRateLimit.use('/limited', testLimiter);
      appWithRateLimit.get('/limited', (_req: Request, res: Response) => {
        res.json({ ok: true });
      });
      appWithRateLimit.use(errorHandler);
    });

    it('allows requests within the rate limit threshold', async () => {
      const res1 = await request(appWithRateLimit).get('/limited');
      expect(res1.status).toBe(200);

      const res2 = await request(appWithRateLimit).get('/limited');
      expect(res2.status).toBe(200);

      const res3 = await request(appWithRateLimit).get('/limited');
      expect(res3.status).toBe(200);
    });

    it('rejects subsequent requests with 429 when limit is exceeded', async () => {
      await request(appWithRateLimit).get('/limited');
      await request(appWithRateLimit).get('/limited');
      await request(appWithRateLimit).get('/limited');

      const res4 = await request(appWithRateLimit).get('/limited');
      expect(res4.status).toBe(429);
      expect(res4.body.error.code).toBe('RATE_LIMITED');
      expect(res4.body.error.message).toContain('Too many requests');
    });
  });

  describe('Validation & Password Hardening', () => {
    it('rejects passwords with less than 8 characters', () => {
      const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: 'Pass1',
        name: 'User',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least 8 characters');
      }
    });

    it('rejects passwords without numbers', () => {
      const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: 'PasswordOnly',
        name: 'User',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least one number');
      }
    });

    it('rejects passwords without letters', () => {
      const result = registerSchema.safeParse({
        email: 'user@example.com',
        password: '1234567890',
        name: 'User',
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('at least one letter');
      }
    });

    it('accepts compliant passwords and transforms email to lowercase', () => {
      const result = registerSchema.safeParse({
        email: 'USER@Example.COM',
        password: 'SecurePassword123',
        name: 'User Name',
        role: 'candidate',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.email).toBe('user@example.com');
      }
    });
  });

  describe('Error Handler Internal Leak Protection', () => {
    let errorApp: express.Express;

    beforeEach(() => {
      errorApp = express();
      errorApp.get('/throw-internal', () => {
        throw new Error('Database password connection string leak test');
      });
      errorApp.use(errorHandler);
    });

    it('never exposes raw error messages or stack traces for internal 500 errors', async () => {
      const res = await request(errorApp).get('/throw-internal');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
      expect(res.body.error.message).toBe('An unexpected error occurred');
      expect(JSON.stringify(res.body)).not.toContain('Database password');
      expect(res.body.error.stack).toBeUndefined();
    });
  });
});
