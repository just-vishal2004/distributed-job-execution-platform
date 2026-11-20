import type { AuthenticatedUser } from '@meridian/types';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      emailVerificationSuppressed?: boolean;
    }
  }
}
