import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { pool } from '../db/pool';
import { hashPassword } from '../utils/password';
import { signToken, COOKIE_NAME } from '../utils/token';

vi.mock('../db/pool', () => {
  const query = vi.fn();
  const connect = vi.fn();
  return {
    pool: { query, connect },
    connectDatabase: vi.fn(),
  };
});

describe('Authentication API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/auth/register', () => {
    it('successfully registers a user with valid credentials', async () => {
      const mockUser = {
        id: '11111111-1111-1111-1111-111111111111',
        email: 'test@example.com',
        role: 'candidate',
        created_at: new Date(),
      };
      const mockSession = { id: '22222222-2222-2222-2222-222222222222' };

      // 1. Check existing email
      (pool.query as any).mockResolvedValueOnce({ rows: [] });

      // Transaction client
      const mockClient = {
        query: vi.fn()
          .mockResolvedValueOnce({}) // BEGIN
          .mockResolvedValueOnce({ rows: [mockUser] }) // INSERT INTO users
          .mockResolvedValueOnce({}) // INSERT INTO profiles
          .mockResolvedValueOnce({ rows: [mockSession] }) // INSERT INTO sessions
          .mockResolvedValueOnce({}), // COMMIT
        release: vi.fn(),
      };
      (pool.connect as any).mockResolvedValueOnce(mockClient);

      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'test@example.com',
          password: 'Password123',
          name: 'Test Candidate',
          role: 'candidate',
        });

      expect(res.status).toBe(201);
      expect(res.body.data.user.email).toBe('test@example.com');
      expect(res.body.data.user.role).toBe('candidate');
      expect(res.body.data.user.name).toBe('Test Candidate');
      // Password hash must never be returned in response
      expect(res.body.data.user.password_hash).toBeUndefined();
      expect(res.body.data.user.password).toBeUndefined();

      // Verify HTTP-only cookie set
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies[0]).toContain(COOKIE_NAME);
      expect(cookies[0]).toContain('HttpOnly');
    });

    it('rejects registration with duplicate email with 409 conflict', async () => {
      (pool.query as any).mockResolvedValueOnce({
        rows: [{ id: 'existing-user-id' }],
      });

      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'duplicate@example.com',
          password: 'Password123',
          name: 'Duplicate User',
          role: 'candidate',
        });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('CONFLICT');
      expect(res.body.error.message).toContain('already exists');
    });

    it('rejects invalid email address with 400 validation error', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'not-an-email',
          password: 'Password123',
          name: 'Invalid Email',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.details).toBeDefined();
    });

    it('rejects weak password with 400 validation error', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({
          email: 'valid@example.com',
          password: 'short',
          name: 'Weak Password',
        });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('rejects malformed json request body', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ invalidField: 123 });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('POST /api/auth/login', () => {
    it('successfully logs in with valid credentials', async () => {
      const passwordHash = await hashPassword('ValidPass123');
      const mockUser = {
        id: '11111111-1111-1111-1111-111111111111',
        email: 'user@example.com',
        password_hash: passwordHash,
        role: 'candidate',
      };
      const mockProfile = { name: 'Logged In User' };
      const mockSession = { id: '33333333-3333-3333-3333-333333333333' };

      (pool.query as any)
        .mockResolvedValueOnce({ rows: [mockUser] }) // SELECT user
        .mockResolvedValueOnce({ rows: [mockProfile] }) // SELECT profile
        .mockResolvedValueOnce({ rows: [mockSession] }); // INSERT session

      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'user@example.com',
          password: 'ValidPass123',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.user.email).toBe('user@example.com');
      expect(res.body.data.user.name).toBe('Logged In User');
      expect(res.body.data.user.password_hash).toBeUndefined();

      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      expect(cookies[0]).toContain(COOKIE_NAME);
      expect(cookies[0]).toContain('HttpOnly');
    });

    it('rejects incorrect password with 401 invalid credentials', async () => {
      const passwordHash = await hashPassword('CorrectPassword123');
      const mockUser = {
        id: '11111111-1111-1111-1111-111111111111',
        email: 'user@example.com',
        password_hash: passwordHash,
        role: 'candidate',
      };

      (pool.query as any).mockResolvedValueOnce({ rows: [mockUser] });

      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'user@example.com',
          password: 'WrongPassword123',
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });

    it('rejects non-existent email with same 401 invalid credentials message', async () => {
      (pool.query as any).mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'nonexistent@example.com',
          password: 'AnyPassword123',
        });

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('INVALID_CREDENTIALS');
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns user identity when authenticated with valid cookie and session', async () => {
      const userId = '11111111-1111-1111-1111-111111111111';
      const sessionId = '44444444-4444-4444-4444-444444444444';
      const token = signToken({ sub: userId, jti: sessionId, role: 'candidate' });

      // attachUser middleware session check
      (pool.query as any)
        .mockResolvedValueOnce({
          rows: [{ user_id: userId, expires_at: new Date(Date.now() + 100000) }],
        })
        // getMe service DB query
        .mockResolvedValueOnce({
          rows: [
            {
              id: userId,
              email: 'candidate@example.com',
              role: 'candidate',
              name: 'Candidate Name',
            },
          ],
        });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`${COOKIE_NAME}=${token}`]);

      expect(res.status).toBe(200);
      expect(res.body.data.user.id).toBe(userId);
      expect(res.body.data.user.email).toBe('candidate@example.com');
      expect(res.body.data.user.role).toBe('candidate');
      expect(res.body.data.user.name).toBe('Candidate Name');
      expect(res.body.data.user.password_hash).toBeUndefined();
    });

    it('rejects unauthenticated request with 401', async () => {
      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });

    it('rejects request with revoked session in database with 401', async () => {
      const userId = '11111111-1111-1111-1111-111111111111';
      const sessionId = '55555555-5555-5555-5555-555555555555';
      const token = signToken({ sub: userId, jti: sessionId, role: 'candidate' });

      // Session lookup returns empty because revoked_at IS NOT NULL
      (pool.query as any).mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', [`${COOKIE_NAME}=${token}`]);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('revokes session in database and clears auth cookie', async () => {
      const userId = '11111111-1111-1111-1111-111111111111';
      const sessionId = '66666666-6666-6666-6666-666666666666';
      const token = signToken({ sub: userId, jti: sessionId, role: 'candidate' });

      // attachUser lookup
      (pool.query as any)
        .mockResolvedValueOnce({
          rows: [{ user_id: userId, expires_at: new Date(Date.now() + 100000) }],
        })
        // logout service revoke update
        .mockResolvedValueOnce({ rows: [] });

      const res = await request(app)
        .post('/api/auth/logout')
        .set('Cookie', [`${COOKIE_NAME}=${token}`]);

      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);

      // Verify revoked_at UPDATE query was executed with sessionId
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE sessions SET revoked_at = NOW()'),
        [sessionId],
      );
    });
  });
});
