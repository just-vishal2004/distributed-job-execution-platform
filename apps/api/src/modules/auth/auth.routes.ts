import { Router, Request, Response, NextFunction } from 'express';
import { registerSchema, loginSchema } from './auth.schemas';
import * as authService from './auth.service';
import { requireAuth } from '../../middleware/auth';
import { authRateLimiter } from '../../middleware/rateLimiter';
import { COOKIE_NAME, cookieOptions } from '../../utils/token';
import { env } from '../../config/env';
import { AppError } from '../../utils/errors';
import {
  verificationConfirmationRateLimit,
  verificationRequestRateLimit,
} from '../../middleware/emailVerificationRateLimit';
import { confirmEmailVerification, requestEmailVerification } from './email-verification.service';
import {
  confirmEmailVerificationSchema,
  requestEmailVerificationSchema,
} from './email-verification.schemas';

const router = Router();
const isProduction = env.NODE_ENV === 'production';

router.post(
  '/email-verification/request',
  verificationRequestRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = requestEmailVerificationSchema.parse(req.body);
      const result = await requestEmailVerification(input.email, req.emailVerificationSuppressed ?? false);
      if (!result.available) {
        throw new AppError(
          'EMAIL_DELIVERY_UNAVAILABLE',
          'Email verification is temporarily unavailable',
          503,
        );
      }
      res.status(202).json({
        data: { message: 'Request received. If verification is needed, check your email or request another link.' },
      });
    } catch (err) {
      next(err);
    }
  },
);

router.post(
  '/email-verification/confirm',
  verificationConfirmationRateLimit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = confirmEmailVerificationSchema.parse(req.body);
      await confirmEmailVerification(input.token);
      res.json({ data: { success: true, message: 'Email verified' } });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/register
router.post(
  '/register',
  authRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = registerSchema.parse(req.body);
      const { user, token } = await authService.register(input);

      res.cookie(COOKIE_NAME, token, cookieOptions(isProduction));
      res.status(201).json({ data: { user } });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/login
router.post(
  '/login',
  authRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const input = loginSchema.parse(req.body);
      const { user, token } = await authService.login(input);

      res.cookie(COOKIE_NAME, token, cookieOptions(isProduction));
      res.json({ data: { user } });
    } catch (err) {
      next(err);
    }
  },
);

// POST /api/auth/logout
router.post(
  '/logout',
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.user?.sessionId) {
        await authService.logout(req.user.sessionId);
      }

      res.clearCookie(COOKIE_NAME, { path: '/' });
      res.json({ data: { success: true } });
    } catch (err) {
      next(err);
    }
  },
);

// GET /api/auth/me
router.get(
  '/me',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = await authService.getMe(req.user!.id);
      res.json({ data: { user } });
    } catch (err) {
      next(err);
    }
  },
);

export default router;
