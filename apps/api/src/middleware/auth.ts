import type { Request, Response, NextFunction } from 'express';
import { pool } from '../db/pool';
import { verifyToken, COOKIE_NAME } from '../utils/token';
import { AppError, unauthenticated, forbidden } from '../utils/errors';
import type { UserRole } from '@meridian/types';

export async function attachUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const token: string | undefined = req.cookies?.[COOKIE_NAME];

  if (!token) {
    return next();
  }

  try {
    const payload = verifyToken(token);

    // Verify session exists and has not been revoked.
    const { rows } = await pool.query<{ user_id: string; expires_at: Date }>(
      `SELECT user_id, expires_at
       FROM sessions
       WHERE id = $1
         AND user_id = $2
         AND revoked_at IS NULL
         AND expires_at > NOW()`,
      [payload.jti, payload.sub],
    );

    if (rows.length === 0) {
      return next();
    }

    req.user = {
      id: payload.sub,
      sessionId: payload.jti,
      role: payload.role,
    };

    next();
  } catch (err) {
    if (err instanceof AppError && err.code !== 'INTERNAL_ERROR') {
      return next();
    }
    next(err);
  }
}

export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.user) {
    return next(unauthenticated());
  }
  next();
}

export function requireRole(...roles: UserRole[]) {
  return function roleMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): void {
    if (!req.user) {
      return next(unauthenticated());
    }

    if (!roles.includes(req.user.role)) {
      return next(
        forbidden(
          `This resource requires one of the following roles: ${roles.join(', ')}`,
        ),
      );
    }

    next();
  };
}
