import type { NextFunction, Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/pool';
import {
  cleanupExpiredVerificationRateLimits,
  verificationConfirmationRateLimit,
  verificationRateLimits,
  verificationRequestRateLimit,
} from '../middleware/emailVerificationRateLimit';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn() } }));

function request(ip: string, body: unknown): Request {
  return {
    ip,
    body,
    socket: { remoteAddress: ip },
  } as Request;
}

async function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  req: Request,
) {
  const next = vi.fn();
  await middleware(req, {} as Response, next);
  return next;
}

describe('shared PostgreSQL verification rate limits', () => {
  beforeEach(() => vi.resetAllMocks());

  it('uses hashed shared keys so distributed IPs consume the same recipient buckets', async () => {
    const sharedCounts = new Map<string, number>();
    vi.mocked(pool.query).mockImplementation(async (_sql, values) => {
      const key = String(values?.[0]);
      const count = (sharedCounts.get(key) ?? 0) + 1;
      sharedCounts.set(key, count);
      return { rows: [{ request_count: count }] } as never;
    });

    const first = request('198.51.100.10', { email: 'person@example.com' });
    const second = request('203.0.113.20', { email: 'PERSON@example.com' });
    await runMiddleware(verificationRequestRateLimit, first);
    await runMiddleware(verificationRequestRateLimit, second);

    const params = vi.mocked(pool.query).mock.calls.map(([, values]) => values?.[0]);
    expect(params).toHaveLength(6);
    expect(params.every((key) => typeof key === 'string' && /^[0-9a-f]{64}$/.test(key))).toBe(true);
    expect(params).not.toContain('person@example.com');
    expect(params).not.toContain('198.51.100.10');
    expect(params).not.toContain('203.0.113.20');
    expect(params[1]).toBe(params[4]);
    expect(first.emailVerificationSuppressed).not.toBe(true);
    expect(second.emailVerificationSuppressed).not.toBe(true);
  });

  it('keeps one IP bucket shared across multiple recipients and survives middleware re-entry', async () => {
    const sharedCounts = new Map<string, number>();
    vi.mocked(pool.query).mockImplementation(async (_sql, values) => {
      const key = String(values?.[0]);
      const count = (sharedCounts.get(key) ?? 0) + 1;
      sharedCounts.set(key, count);
      return { rows: [{ request_count: count }] } as never;
    });

    await runMiddleware(verificationRequestRateLimit, request('198.51.100.5', { email: 'one@example.com' }));
    await runMiddleware(verificationRequestRateLimit, request('198.51.100.5', { email: 'two@example.com' }));
    const calls = vi.mocked(pool.query).mock.calls;
    expect(calls[0][1]?.[0]).toBe(calls[3][1]?.[0]);
    expect(calls[1][1]?.[0]).not.toBe(calls[4][1]?.[0]);
  });

  it('atomically suppresses a recipient flood across concurrent independent clients', async () => {
    const sharedCounts = new Map<string, number>();
    vi.mocked(pool.query).mockImplementation(async (_sql, values) => {
      const key = String(values?.[0]);
      const count = (sharedCounts.get(key) ?? 0) + 1;
      sharedCounts.set(key, count);
      return { rows: [{ request_count: count }] } as never;
    });

    const requests = ['198.51.100.11', '198.51.100.12', '198.51.100.13', '198.51.100.14']
      .map((ip) => request(ip, { email: 'target@example.com' }));
    await Promise.all(requests.map((req) => runMiddleware(verificationRequestRateLimit, req)));

    expect(requests.filter((req) => req.emailVerificationSuppressed === true)).toHaveLength(1);
    expect([...sharedCounts.values()].filter((count) => count === 4)).toHaveLength(2);
  });

  it('suppresses recipient-limited sends without revealing the decision in its HTTP result', async () => {
    let hourlyChecks = 0;
    vi.mocked(pool.query).mockImplementation(async (_sql, values) => {
      if (values?.[1] === '1 hour') hourlyChecks++;
      return { rows: [{ request_count: hourlyChecks === 2 ? 4 : 1 }] } as never;
    });
    const req = request('198.51.100.6', { email: 'person@example.com' });
    const next = await runMiddleware(verificationRequestRateLimit, req);
    expect(next).toHaveBeenCalledWith();
    expect(req.emailVerificationSuppressed).toBe(true);
  });

  it('limits confirmation attempts independently and bounds expired-row cleanup', async () => {
    expect(verificationRateLimits).toEqual({
      requestIpPerHour: 10,
      requestRecipientPerHour: 3,
      requestRecipientPerDay: 10,
      confirmationIpPerHour: 30,
      confirmationTokenPerHour: 10,
    });
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [{ request_count: 1 }] } as never)
      .mockResolvedValueOnce({ rows: [{ request_count: 11 }] } as never);
    const next = await runMiddleware(
      verificationConfirmationRateLimit,
      request('198.51.100.7', { token: 'token-value' }),
    );
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_INVALID', statusCode: 400 }));

    vi.mocked(pool.query).mockResolvedValueOnce({ rows: Array.from({ length: 3 }, () => ({ key_hash: 'a'.repeat(64) })) } as never);
    expect(await cleanupExpiredVerificationRateLimits()).toBe(3);
    expect(String(vi.mocked(pool.query).mock.calls.at(-1)?.[0])).toContain('LIMIT $1');
    expect(vi.mocked(pool.query).mock.calls.at(-1)?.[1]).toEqual([2_000]);
  });
});
