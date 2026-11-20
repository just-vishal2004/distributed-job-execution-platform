import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Request, Response } from 'express';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { attachUser, requireAuth, requireRole } from '../middleware/auth';
import { errorHandler } from '../middleware/errorHandler';
import { signToken, COOKIE_NAME } from '../utils/token';
import { pool } from '../db/pool';

vi.mock('../db/pool', () => ({
  pool: { query: vi.fn() },
}));

describe('Authorization & RBAC Middleware', () => {
  let testApp: express.Express;

  beforeEach(() => {
    vi.clearAllMocks();

    testApp = express();
    testApp.use(cookieParser());
    testApp.use(attachUser);

    // Protected routes with different role requirements
    testApp.get(
      '/candidate-only',
      requireAuth,
      requireRole('candidate'),
      (_req: Request, res: Response) => {
        res.json({ ok: true, role: 'candidate' });
      },
    );

    testApp.get(
      '/employer-only',
      requireAuth,
      requireRole('employer'),
      (_req: Request, res: Response) => {
        res.json({ ok: true, role: 'employer' });
      },
    );

    testApp.get(
      '/admin-only',
      requireAuth,
      requireRole('admin'),
      (_req: Request, res: Response) => {
        res.json({ ok: true, role: 'admin' });
      },
    );

    testApp.use(errorHandler);
  });

  it('rejects unauthenticated request with 401', async () => {
    const res = await request(testApp).get('/candidate-only');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
  });

  it('allows candidate access to candidate-only route', async () => {
    const token = signToken({
      sub: 'candidate-id',
      jti: 'session-id-1',
      role: 'candidate',
    });

    (pool.query as any).mockResolvedValueOnce({
      rows: [{ user_id: 'candidate-id', expires_at: new Date(Date.now() + 100000) }],
    });

    const res = await request(testApp)
      .get('/candidate-only')
      .set('Cookie', [`${COOKIE_NAME}=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('denies candidate access to employer-only route with 403', async () => {
    const token = signToken({
      sub: 'candidate-id',
      jti: 'session-id-2',
      role: 'candidate',
    });

    (pool.query as any).mockResolvedValueOnce({
      rows: [{ user_id: 'candidate-id', expires_at: new Date(Date.now() + 100000) }],
    });

    const res = await request(testApp)
      .get('/employer-only')
      .set('Cookie', [`${COOKIE_NAME}=${token}`]);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toContain('employer');
  });

  it('allows employer access to employer-only route', async () => {
    const token = signToken({
      sub: 'employer-id',
      jti: 'session-id-3',
      role: 'employer',
    });

    (pool.query as any).mockResolvedValueOnce({
      rows: [{ user_id: 'employer-id', expires_at: new Date(Date.now() + 100000) }],
    });

    const res = await request(testApp)
      .get('/employer-only')
      .set('Cookie', [`${COOKIE_NAME}=${token}`]);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('allows admin access to admin-only route and denies non-admin', async () => {
    const adminToken = signToken({
      sub: 'admin-id',
      jti: 'session-id-4',
      role: 'admin',
    });

    (pool.query as any).mockResolvedValueOnce({
      rows: [{ user_id: 'admin-id', expires_at: new Date(Date.now() + 100000) }],
    });

    const adminRes = await request(testApp)
      .get('/admin-only')
      .set('Cookie', [`${COOKIE_NAME}=${adminToken}`]);

    expect(adminRes.status).toBe(200);
    expect(adminRes.body.ok).toBe(true);

    // Employer attempting admin route
    const employerToken = signToken({
      sub: 'employer-id',
      jti: 'session-id-5',
      role: 'employer',
    });

    (pool.query as any).mockResolvedValueOnce({
      rows: [{ user_id: 'employer-id', expires_at: new Date(Date.now() + 100000) }],
    });

    const employerRes = await request(testApp)
      .get('/admin-only')
      .set('Cookie', [`${COOKIE_NAME}=${employerToken}`]);

    expect(employerRes.status).toBe(403);
    expect(employerRes.body.error.code).toBe('FORBIDDEN');
  });
});
