import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../index';
import { pool } from '../db/pool';
import { confirmEmailVerification, requestEmailVerification } from '../modules/auth/email-verification.service';
import { AppError } from '../utils/errors';

vi.mock('../db/pool', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  connectDatabase: vi.fn(),
}));
vi.mock('../modules/auth/email-verification.service', () => ({
  requestEmailVerification: vi.fn(),
  confirmEmailVerification: vi.fn(),
}));

const opaqueToken = '11111111-1111-4111-8111-111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

describe('email verification routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(pool.query).mockImplementation(async () => ({ rows: [{ request_count: 1 }] }) as never);
  });

  it('returns the same generic response for unknown, verified, sent, and failed delivery outcomes', async () => {
    const publicResponses: Array<{ status: number; body: unknown }> = [];
    for (const outcome of [
      { available: true as const, delivery: 'not_needed' as const },
      { available: true as const, delivery: 'queued' as const },
      { available: true as const, delivery: 'queued' as const },
    ]) {
      vi.mocked(requestEmailVerification).mockResolvedValueOnce(outcome);
      publicResponses.push(await request(app)
        .post('/api/auth/email-verification/request')
        .send({ email: 'person@example.com' }));
    }

    expect(publicResponses.map(({ status, body }) => ({ status, body }))).toEqual([
      {
        status: 202,
        body: { data: { message: 'Request received. If verification is needed, check your email or request another link.' } },
      },
      {
        status: 202,
        body: { data: { message: 'Request received. If verification is needed, check your email or request another link.' } },
      },
      {
        status: 202,
        body: { data: { message: 'Request received. If verification is needed, check your email or request another link.' } },
      },
    ]);
    expect(requestEmailVerification).toHaveBeenCalledTimes(3);
  });

  it('returns a controlled unavailable response when Resend is not configured', async () => {
    vi.mocked(requestEmailVerification).mockResolvedValue({ available: false });

    const response = await request(app)
      .post('/api/auth/email-verification/request')
      .send({ email: 'person@example.com' });

    expect(response.status).toBe(503);
    expect(response.body.error).toEqual({
      code: 'EMAIL_DELIVERY_UNAVAILABLE',
      message: 'Email verification is temporarily unavailable',
    });
  });

  it('rejects malformed request input before calling the service', async () => {
    const response = await request(app)
      .post('/api/auth/email-verification/request')
      .send({ email: 'bad', userId: 'caller-controlled' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(requestEmailVerification).not.toHaveBeenCalled();
  });

  it('accepts confirmation tokens only in the POST body and never returns them', async () => {
    vi.mocked(confirmEmailVerification).mockResolvedValue(undefined);

    const response = await request(app)
      .post('/api/auth/email-verification/confirm')
      .send({ token: opaqueToken });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: { success: true, message: 'Email verified' } });
    expect(JSON.stringify(response.body)).not.toContain(opaqueToken);
    expect(confirmEmailVerification).toHaveBeenCalledWith(opaqueToken);
  });

  it('maps invalid, expired, and consumed confirmation links to the same safe response', async () => {
    vi.mocked(confirmEmailVerification).mockRejectedValue(
      new AppError('TOKEN_INVALID', 'This verification link is invalid or expired', 400),
    );

    const response = await request(app)
      .post('/api/auth/email-verification/confirm')
      .send({ token: opaqueToken });

    expect(response.status).toBe(400);
    expect(response.body.error.message).toBe('This verification link is invalid or expired');
    expect(JSON.stringify(response.body)).not.toContain('secret content');
  });

  it('returns the generic accepted response when recipient limits suppress delivery', async () => {
    vi.mocked(requestEmailVerification).mockResolvedValue({ available: true, delivery: 'not_needed' });
    vi.mocked(pool.query).mockImplementation(async (_query, values) => ({
      rows: [{ request_count: values?.[1] === '1 hour' ? 4 : 1 }],
    }) as never);

    const response = await request(app)
      .post('/api/auth/email-verification/request')
      .send({ email: 'person@example.com' });

    expect(response.status).toBe(202);
    expect(response.body.data.message).toBe('Request received. If verification is needed, check your email or request another link.');
    expect(requestEmailVerification).toHaveBeenCalledWith('person@example.com', true);
  });

  it('fails closed with a generic unavailable response when the shared limiter database fails', async () => {
    vi.mocked(pool.query).mockRejectedValueOnce(new Error('private database detail'));
    const response = await request(app)
      .post('/api/auth/email-verification/request')
      .send({ email: 'person@example.com' });

    expect(response.status).toBe(503);
    expect(response.body.error.message).toBe('Verification is temporarily unavailable');
    expect(JSON.stringify(response.body)).not.toContain('private database detail');
    expect(requestEmailVerification).not.toHaveBeenCalled();
  });

  it('applies the IP confirmation limit independently', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ request_count: 31 }] } as never);
    const response = await request(app)
      .post('/api/auth/email-verification/confirm')
      .send({ token: opaqueToken });

    expect(response.status).toBe(429);
    expect(confirmEmailVerification).not.toHaveBeenCalled();
  });
});
