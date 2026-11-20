import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { confirmEmailVerificationSchema, requestEmailVerificationSchema } from '../modules/auth/email-verification.schemas';
import { loginSchema, registerSchema, type LoginInput, type RegisterInput } from '../modules/auth/auth.schemas';
import { errorHandler } from '../middleware/errorHandler';
import {
  changeMembershipRoleSchema,
  createProjectSchema,
  membershipParamsSchema,
  projectIdParamsSchema,
  transferOwnershipSchema,
} from '../routes/project.schemas';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const validUuid = '123e4567-e89b-42d3-a456-426614174000';

function emailWithLength(length: number): string {
  const prefix = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.`;
  const suffix = '.com';
  const middleLength = length - prefix.length - suffix.length;
  return `${prefix}${'d'.repeat(middleLength)}${suffix}`;
}

function responseDouble() {
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn(),
  };
}

function runErrorHandler(error: unknown, response = responseDouble()) {
  const request = {
    method: 'POST',
    route: { path: '/schema-test' },
  } as Request;

  errorHandler(
    error,
    request,
    response as unknown as Response,
    vi.fn() as unknown as NextFunction,
  );
  return response;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authentication schemas under Zod 3', () => {
  it('normalizes registration email, trims names, and defaults the role', () => {
    const result = registerSchema.parse({
      email: 'USER@Example.COM',
      password: 'A1234567',
      name: '  Example User  ',
    });
    const output: RegisterInput = result;

    expect(output).toEqual({
      email: 'user@example.com',
      password: 'A1234567',
      name: 'Example User',
      role: 'candidate',
    });
    const explicitEmployer = registerSchema.parse({
      email: 'user@example.com',
      password: `A${'1'.repeat(127)}`,
      name: 'Employer',
      role: 'employer',
    });
    expect(explicitEmployer.password).toHaveLength(128);
    expect(explicitEmployer.role).toBe('employer');
  });

  it('accepts email length 255 and rejects length 256', () => {
    expect(registerSchema.safeParse({
      email: emailWithLength(255),
      password: 'A1234567',
      name: 'User',
    }).success).toBe(true);
    expect(registerSchema.safeParse({
      email: emailWithLength(256),
      password: 'A1234567',
      name: 'User',
    }).success).toBe(false);
  });

  it('enforces password minimum, maximum, and both refinements', () => {
    const validBase = { email: 'user@example.com', name: 'User' };
    expect(registerSchema.safeParse({ ...validBase, password: 'A1234567' }).success).toBe(true);

    const short = registerSchema.safeParse({ ...validBase, password: 'A123456' });
    expect(short.success).toBe(false);
    if (!short.success) expect(short.error.issues[0].message).toContain('at least 8 characters');

    const long = registerSchema.safeParse({ ...validBase, password: `A${'1'.repeat(128)}` });
    expect(long.success).toBe(false);
    if (!long.success) expect(long.error.issues[0].message).toContain('must not exceed 128');

    const noNumber = registerSchema.safeParse({ ...validBase, password: 'PasswordOnly' });
    expect(noNumber.success).toBe(false);
    if (!noNumber.success) expect(noNumber.error.issues[0].message).toContain('at least one number');

    const noLetter = registerSchema.safeParse({ ...validBase, password: '12345678' });
    expect(noLetter.success).toBe(false);
    if (!noLetter.success) expect(noLetter.error.issues[0].message).toContain('at least one letter');
  });

  it('applies name length checks before trimming and accepts a whitespace-only name as empty output', () => {
    const whitespaceName = registerSchema.parse({
      email: 'user@example.com',
      password: 'A1234567',
      name: '   ',
    });
    expect(whitespaceName.name).toBe('');

    const oversizedName = registerSchema.safeParse({
      email: 'user@example.com',
      password: 'A1234567',
      name: 'x'.repeat(101),
    });
    expect(oversizedName.success).toBe(false);
  });

  it('normalizes login email and rejects invalid email or an empty password', () => {
    const output: LoginInput = loginSchema.parse({ email: 'USER@Example.COM', password: 'x' });
    expect(output).toEqual({
      email: 'user@example.com',
      password: 'x',
    });
    expect(loginSchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'user@example.com', password: '' }).success).toBe(false);
  });

  it('strips unknown registration fields by default', () => {
    const result = registerSchema.parse({
      email: 'user@example.com',
      password: 'A1234567',
      name: 'User',
      extra: 'discarded',
    });
    expect(result).not.toHaveProperty('extra');
  });
});

describe('email verification schemas under Zod 3', () => {
  it('normalizes request email and accepts the 255-character boundary', () => {
    expect(requestEmailVerificationSchema.parse({ email: 'USER@Example.COM' }).email)
      .toBe('user@example.com');
    expect(requestEmailVerificationSchema.safeParse({ email: emailWithLength(255) }).success)
      .toBe(true);
    expect(requestEmailVerificationSchema.safeParse({ email: emailWithLength(256) }).success)
      .toBe(false);
  });

  it('rejects malformed email, missing values, and unknown request keys', () => {
    expect(requestEmailVerificationSchema.safeParse({ email: 'bad' }).success).toBe(false);
    expect(requestEmailVerificationSchema.safeParse({}).success).toBe(false);
    expect(requestEmailVerificationSchema.safeParse({ email: 'user@example.com', extra: true }).success)
      .toBe(false);
  });

  it('accepts a 101-character token matching the UUID and digest pattern', () => {
    const token = `${validUuid}.${'a'.repeat(64)}`;
    expect(token).toHaveLength(101);
    expect(confirmEmailVerificationSchema.parse({ token })).toEqual({ token });
  });

  it('rejects token length, format, missing field, and unknown-key violations', () => {
    const token = `${validUuid}.${'a'.repeat(64)}`;
    for (const invalidToken of [token.slice(1), `${token}a`, `${validUuid}.g${'a'.repeat(63)}`]) {
      expect(confirmEmailVerificationSchema.safeParse({ token: invalidToken }).success).toBe(false);
    }
    expect(confirmEmailVerificationSchema.safeParse({}).success).toBe(false);
    expect(confirmEmailVerificationSchema.safeParse({ token, extra: true }).success).toBe(false);
  });
});

describe('project schemas under Zod 3', () => {
  it('accepts PostgreSQL UUID values without enforcing version or variant bits', () => {
    expect(projectIdParamsSchema.parse({ projectId: validUuid }).projectId).toBe(validUuid);
    expect(projectIdParamsSchema.safeParse({
      projectId: '00000000-0000-0000-0000-000000000000',
    }).success).toBe(true);
    expect(projectIdParamsSchema.safeParse({
      projectId: '123e4567-e89b-42d3-7456-426614174000',
    }).success).toBe(true);
    expect(projectIdParamsSchema.safeParse({ projectId: 'not-a-uuid' }).success).toBe(false);
  });

  it('strips unknown route parameter keys from ordinary objects', () => {
    expect(projectIdParamsSchema.parse({ projectId: validUuid, extra: 'ignored' }))
      .toEqual({ projectId: validUuid });
    expect(membershipParamsSchema.parse({ projectId: validUuid, userId: validUuid, extra: 'ignored' }))
      .toEqual({ projectId: validUuid, userId: validUuid });
  });

  it('trims project names and enforces one through 255 characters', () => {
    expect(createProjectSchema.parse({ name: '  Project  ' })).toEqual({ name: 'Project' });
    expect(createProjectSchema.parse({ name: 'x'.repeat(255) }).name).toHaveLength(255);
    expect(createProjectSchema.safeParse({ name: 'x'.repeat(256) }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: '   ' }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 'Project', extra: true }).success).toBe(false);
  });

  it('accepts only the documented membership roles and rejects strict-body extras', () => {
    expect(changeMembershipRoleSchema.parse({ role: 'admin' })).toEqual({ role: 'admin' });
    expect(changeMembershipRoleSchema.parse({ role: 'member' })).toEqual({ role: 'member' });
    expect(changeMembershipRoleSchema.safeParse({ role: 'owner' }).success).toBe(false);
    expect(changeMembershipRoleSchema.safeParse({ role: 'member', extra: true }).success).toBe(false);
    expect(transferOwnershipSchema.parse({
      recipientUserId: validUuid,
      formerOwnerRole: 'removed',
    }).formerOwnerRole).toBe('removed');
    expect(transferOwnershipSchema.safeParse({
      recipientUserId: validUuid,
      formerOwnerRole: 'owner',
    }).success).toBe(false);
    expect(transferOwnershipSchema.safeParse({
      recipientUserId: validUuid,
      formerOwnerRole: 'member',
      extra: true,
    }).success).toBe(false);
    expect(transferOwnershipSchema.safeParse({ recipientUserId: validUuid }).success).toBe(false);
  });
});

describe('error-handler Zod response contract without HTTP sockets', () => {
  it('returns 400 and projects issue paths and messages under the stable top-level error', () => {
    const parsed = createProjectSchema.safeParse({ name: '' });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;

    const response = runErrorHandler(parsed.error);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(response.json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Invalid request data',
        details: [{
          path: 'name',
          message: 'String must contain at least 1 character(s)',
        }],
      },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps intentional AppError responses and hides unexpected internal details', () => {
    const expected = runErrorHandler(new AppError('FORBIDDEN', 'Project access denied', 403));
    expect(expected.status).toHaveBeenCalledWith(403);
    expect(expected.json).toHaveBeenCalledWith({
      error: { code: 'FORBIDDEN', message: 'Project access denied' },
    });
    expect(logger.warn).toHaveBeenCalledWith('Request error', {
      code: 'FORBIDDEN',
      message: 'Project access denied',
      statusCode: 403,
    });

    vi.clearAllMocks();
    const secret = 'SQL password bearer-token should-stay-internal';
    const unexpected = runErrorHandler(new Error(secret));
    expect(unexpected.status).toHaveBeenCalledWith(500);
    expect(unexpected.json).toHaveBeenCalledWith({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
    expect(JSON.stringify(unexpected.json.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(secret);
    expect(logger.error).toHaveBeenCalledWith('Unexpected request error', {
      event: 'unexpected_request_error',
      method: 'POST',
      route: '/schema-test',
      statusCode: 500,
    });
  });
});
