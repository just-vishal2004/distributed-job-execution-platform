import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from './errors';
import type { UserRole } from '@meridian/types';

export interface TokenPayload {
  sub: string;
  jti: string;
  role: UserRole;
}

export function signToken(payload: TokenPayload): string {
  const options: SignOptions = {
    expiresIn: env.JWT_EXPIRES_IN as SignOptions['expiresIn'],
    algorithm: 'HS256',
  };
  return jwt.sign(payload, env.JWT_SECRET, options);
}

export function verifyToken(token: string): TokenPayload {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'],
    });

    if (typeof payload !== 'object' || payload === null) {
      throw new AppError('TOKEN_INVALID', 'Invalid token', 401);
    }

    return payload as TokenPayload;
  } catch (err) {
    if (err instanceof AppError) throw err;

    if (err instanceof jwt.TokenExpiredError) {
      throw new AppError('TOKEN_EXPIRED', 'Token has expired', 401);
    }

    throw new AppError('TOKEN_INVALID', 'Invalid token', 401);
  }
}

export const COOKIE_NAME = 'auth_token' as const;

export function cookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax' as const,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}
