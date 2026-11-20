import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/pool';
import { confirmEmailVerification, requestEmailVerification } from '../modules/auth/email-verification.service';

const deliveryMock = vi.hoisted(() => ({ sendVerificationEmail: vi.fn() }));
vi.mock('../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../modules/auth/email-delivery', () => ({ verificationEmailDelivery: deliveryMock }));

const userId = '22222222-2222-4222-8222-222222222222';
const tokenId = '11111111-1111-4111-8111-111111111111';
const secret = 'a'.repeat(64);
const userEmail = 'person@example.com';

type UserRow = { id: string; email: string; email_verified: boolean };
type TokenRow = {
  id: string;
  user_id: string;
  email: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  revoked_at: Date | null;
};

let state: { user: UserRow | null; tokens: TokenRow[]; statements: string[]; requestPayloads: Buffer[] };
let failUserVerificationUpdate: boolean;
let restoreOnRollback: boolean;

function createClient() {
  let snapshot: { user: UserRow | null; tokens: TokenRow[] } | null = null;
  const query = vi.fn(async (sqlValue: string, values: unknown[] = []) => {
    const sql = sqlValue.replace(/\s+/g, ' ').trim();
    state.statements.push(sql);
    const rows: unknown[] = [];
    if (sql === 'BEGIN') {
      snapshot = {
        user: state.user ? { ...state.user } : null,
        tokens: state.tokens.map((token) => ({ ...token })),
      };
      return { rows };
    }
    if (sql === 'ROLLBACK') {
      if (restoreOnRollback && snapshot) {
        state.user = snapshot.user;
        state.tokens = snapshot.tokens;
      }
      return { rows };
    }
    if (sql === 'COMMIT') return { rows };

    if (sql.startsWith('INSERT INTO email_verification_requests')) {
      state.requestPayloads.push(values[0] as Buffer);
      rows.push({ id: '55555555-5555-4555-8555-555555555555' });
    } else if (sql.includes('FROM users') && sql.includes('WHERE email = $1')) {
      if (state.user?.email === values[0]) rows.push({ ...state.user });
    } else if (sql.includes('FROM users') && sql.includes('WHERE id = $1 FOR UPDATE')) {
      if (state.user?.id === values[0]) rows.push({ ...state.user });
    } else if (sql.includes('FROM email_verification_tokens') && sql.includes('ORDER BY id')) {
      rows.push(...state.tokens
        .filter((token) => token.user_id === values[0]
          && token.email === values[1]
          && token.consumed_at === null
          && token.revoked_at === null)
        .map(({ id }) => ({ id })));
    } else if (sql.startsWith('UPDATE email_verification_tokens') && sql.includes('ANY($1::uuid[])')) {
      const ids = values[0] as string[];
      for (const token of state.tokens) {
        if (ids.includes(token.id) && token.consumed_at === null && token.revoked_at === null) {
          token.revoked_at = new Date();
          rows.push({ id: token.id });
        }
      }
    } else if (sql.startsWith('INSERT INTO email_verification_tokens')) {
      const inserted: TokenRow = {
        id: state.tokens.length === 0 ? tokenId : '44444444-4444-4444-8444-444444444444',
        user_id: String(values[0]),
        email: String(values[1]),
        token_hash: String(values[2]),
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        consumed_at: null,
        revoked_at: null,
      };
      state.tokens.push(inserted);
      rows.push({ id: inserted.id });
    } else if (sql.includes('FROM email_verification_tokens') && sql.includes('FOR UPDATE')) {
      const token = state.tokens.find((item) => item.id === values[0] && item.user_id === values[1]);
      if (token) rows.push({ ...token, is_unexpired: token.expires_at.getTime() > Date.now() });
    } else if (sql.includes('FROM email_verification_tokens WHERE id = $1')) {
      const token = state.tokens.find((item) => item.id === values[0]);
      if (token) rows.push({ id: token.id, user_id: token.user_id });
    } else if (sql.startsWith('UPDATE email_verification_tokens') && sql.includes('SET consumed_at')) {
      const token = state.tokens.find((item) => item.id === values[0]
        && item.user_id === values[1]
        && item.token_hash === values[2]
        && item.consumed_at === null
        && item.revoked_at === null
        && item.expires_at.getTime() > Date.now());
      if (token) {
        token.consumed_at = new Date();
        rows.push({ id: token.id });
      }
    } else if (sql.startsWith('UPDATE users SET email_verified')) {
      const user = state.user;
      if (!failUserVerificationUpdate
        && user !== null
        && user.id === values[0]
        && user.email === values[1]
        && !user.email_verified) {
        user.email_verified = true;
        rows.push({ id: user.id });
      }
    } else {
      throw new Error(`Unexpected SQL in test mock: ${sql}`);
    }
    return { rows };
  });
  return { query, release: vi.fn() };
}

function makeToken(email = userEmail, overrides: Partial<TokenRow> = {}): TokenRow {
  return {
    id: tokenId,
    user_id: userId,
    email,
    token_hash: createHash('sha256').update(secret).digest('hex'),
    expires_at: new Date(Date.now() + 60_000),
    consumed_at: null,
    revoked_at: null,
    ...overrides,
  };
}

function setClient(): ReturnType<typeof createClient> {
  const client = createClient();
  vi.mocked(pool.connect).mockResolvedValue(client as never);
  return client;
}

describe('email verification service', () => {
  beforeEach(() => {
    state = {
      user: { id: userId, email: userEmail, email_verified: false },
      tokens: [],
      statements: [],
      requestPayloads: [],
    };
    failUserVerificationUpdate = false;
    restoreOnRollback = false;
    vi.clearAllMocks();
    deliveryMock.sendVerificationEmail.mockResolvedValue({ ok: true });
    setClient();
    vi.mocked(pool.query).mockImplementation(async () => ({
      rows: state.tokens[0] ? [{ id: state.tokens[0].id, user_id: state.tokens[0].user_id }] : [],
    }) as never);
  });

  it('durably queues the normalized request without waiting for or exposing provider delivery', async () => {
    const client = setClient();
    deliveryMock.sendVerificationEmail.mockImplementation(async () => {
      throw new Error('The request path must not call the provider');
    });

    const result = await requestEmailVerification(`  ${userEmail.toUpperCase()}  `);

    expect(result).toEqual({ available: true, delivery: 'queued' });
    expect(state.requestPayloads).toHaveLength(1);
    expect(state.requestPayloads[0].toString('utf8')).not.toContain(userEmail);
    expect(state.statements).toEqual([
      'BEGIN',
      'INSERT INTO email_verification_requests (email_ciphertext, nonce, auth_tag) VALUES ($1, $2, $3) RETURNING id',
      'COMMIT',
    ]);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
    expect(deliveryMock.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('queues identical work for unknown and verified addresses without a user lookup', async () => {
    const firstClient = setClient();
    state.user = null;
    expect(await requestEmailVerification(userEmail)).toEqual({ available: true, delivery: 'queued' });

    state.user = { id: userId, email: userEmail, email_verified: true };
    const secondClient = createClient();
    vi.mocked(pool.connect).mockResolvedValueOnce(secondClient as never);
    expect(await requestEmailVerification(userEmail)).toEqual({ available: true, delivery: 'queued' });
    expect(state.requestPayloads).toHaveLength(2);
    expect(firstClient.query.mock.calls.every(([sql]) => !String(sql).includes('FROM users'))).toBe(true);
    expect(secondClient.query.mock.calls.every(([sql]) => !String(sql).includes('FROM users'))).toBe(true);
    expect(deliveryMock.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('does not invoke provider delivery while accepting a request', async () => {
    setClient();
    await requestEmailVerification(userEmail);
    expect(deliveryMock.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('suppresses recipient-limited requests without writing durable queue work', async () => {
    vi.mocked(pool.connect).mockClear();
    expect(await requestEmailVerification(userEmail, true)).toEqual({ available: true, delivery: 'not_needed' });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('consumes a valid token and verifies the current matching email in one transaction', async () => {
    state.tokens.push(makeToken());
    setClient();

    await expect(confirmEmailVerification(`${tokenId}.${secret}`)).resolves.toBeUndefined();

    expect(state.tokens[0].consumed_at).toBeInstanceOf(Date);
    expect(state.user?.email_verified).toBe(true);
    expect(state.statements).toContain('COMMIT');
    expect(state.statements.findIndex((sql) => sql.includes('FROM users WHERE id = $1 FOR UPDATE')))
      .toBeLessThan(state.statements.findIndex((sql) => sql.includes('FOR UPDATE') && sql.includes('email_verification_tokens')));
  });

  it.each([
    ['expired', makeToken(userEmail, { expires_at: new Date(Date.now() - 1) })],
    ['revoked', makeToken(userEmail, { revoked_at: new Date() })],
    ['consumed', makeToken(userEmail, { consumed_at: new Date() })],
    ['wrong email', makeToken('other@example.com')],
  ])('rejects a %s token without partial verification', async (_name, token) => {
    state.tokens.push(token);
    setClient();

    await expect(confirmEmailVerification(`${tokenId}.${secret}`)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    expect(state.user?.email_verified).toBe(false);
    expect(state.statements).toContain('ROLLBACK');
  });

  it('rejects a token issued to an address that no longer matches the user', async () => {
    state.user = { id: userId, email: 'changed@example.com', email_verified: false };
    state.tokens.push(makeToken(userEmail));
    setClient();

    await expect(confirmEmailVerification(`${tokenId}.${secret}`)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    expect(state.user.email_verified).toBe(false);
  });

  it('rolls back token consumption if the guarded user verification update affects no row', async () => {
    state.tokens.push(makeToken());
    failUserVerificationUpdate = true;
    restoreOnRollback = true;
    const client = setClient();

    await expect(confirmEmailVerification(`${tokenId}.${secret}`)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });

    expect(client.query.mock.calls.some(([sql]) => String(sql) === 'ROLLBACK')).toBe(true);
    expect(state.user?.email_verified).toBe(false);
    expect(state.tokens[0].consumed_at).toBeNull();
  });

  it('rejects malformed tokens before database access', async () => {
    vi.mocked(pool.query).mockClear();
    vi.mocked(pool.connect).mockClear();

    await expect(confirmEmailVerification('malformed')).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('allows only one guarded consumption when duplicate confirmations race in the mocked client', async () => {
    state.tokens.push(makeToken());
    const firstClient = createClient();
    const secondClient = createClient();
    vi.mocked(pool.connect)
      .mockResolvedValueOnce(firstClient as never)
      .mockResolvedValueOnce(secondClient as never);
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: tokenId, user_id: userId }] } as never);

    const results = await Promise.allSettled([
      confirmEmailVerification(`${tokenId}.${secret}`),
      confirmEmailVerification(`${tokenId}.${secret}`),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(state.tokens.filter((token) => token.consumed_at !== null)).toHaveLength(1);
    expect(state.user?.email_verified).toBe(true);
  });
});
