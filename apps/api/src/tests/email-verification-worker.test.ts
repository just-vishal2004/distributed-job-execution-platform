import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/pool';
import { verificationEmailDelivery } from '../modules/auth/email-delivery';
import { decryptEmailToken, encryptEmailToken, encryptRequestedEmail } from '../modules/auth/email-token-crypto';
import { runEmailVerificationDeliveryCycle } from '../modules/auth/email-verification-worker';

const providerMock = vi.hoisted(() => ({ sendVerificationEmail: vi.fn() }));
vi.mock('../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../modules/auth/email-delivery', () => ({ verificationEmailDelivery: providerMock }));

if (!verificationEmailDelivery) throw new Error('Email delivery mock was not loaded');
const mockProvider = verificationEmailDelivery;

const userId = '22222222-2222-4222-8222-222222222222';
const tokenId = '11111111-1111-4111-8111-111111111111';
const deliveryId = '33333333-3333-4333-8333-333333333333';
const email = 'person@example.com';
const secret = 'b'.repeat(64);
type MutableDeliveryState = {
  state: 'pending' | 'leased' | 'delivered' | 'failed' | 'cancelled';
  attemptCount: number;
  leaseId: string | null;
};

function createClient(
  mode: 'request' | 'delivery',
  overrides: { userVerified?: boolean; tokenRevoked?: boolean } = {},
  sharedDelivery?: MutableDeliveryState,
) {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const deliveryState = sharedDelivery ?? { state: 'pending' as const, attemptCount: 0, leaseId: null };
  const encrypted = encryptEmailToken(`${tokenId}.${secret}`);
  const query = vi.fn(async (sqlValue: string, rawValues: unknown[] = []) => {
    const sql = sqlValue.replace(/\s+/g, ' ').trim();
    const values = rawValues;
    statements.push({ sql, values });
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.startsWith('SET LOCAL')) return { rows: [] };

    if (sql.includes('FROM email_verification_requests')) {
      if (mode !== 'request') return { rows: [] };
      const queuedEmail = encryptRequestedEmail(email);
      return { rows: [{ id: '55555555-5555-4555-8555-555555555555', ciphertext: queuedEmail.ciphertext, nonce: queuedEmail.nonce, auth_tag: queuedEmail.authTag }] };
    }
    if (sql.includes('FROM users WHERE email = $1 FOR UPDATE')) {
      return { rows: mode === 'request' ? [{ id: userId, email, email_verified: Boolean(overrides.userVerified) }] : [] };
    }
    if (sql.includes('FROM users WHERE id = $1 FOR UPDATE')) {
      return { rows: [{ id: userId, email, email_verified: Boolean(overrides.userVerified) }] };
    }
    if (sql.includes('FROM email_verification_tokens') && sql.includes('ORDER BY id FOR UPDATE')) {
      return { rows: [] };
    }
    if (sql.includes('FROM email_verification_tokens WHERE id = $1 AND user_id = $2 FOR UPDATE')) {
      return {
        rows: [{
          id: tokenId,
          email,
          token_hash: createHash('sha256').update(secret).digest('hex'),
          expires_at: new Date(Date.now() + 60_000),
          consumed_at: null,
          revoked_at: overrides.tokenRevoked ? new Date() : null,
          is_unexpired: true,
        }],
      };
    }
    if (sql.includes('FROM email_verification_deliveries') && sql.includes('FOR UPDATE SKIP LOCKED')) {
      return {
        rows: [{
          id: deliveryId,
          state: deliveryState.state,
          attempt_count: deliveryState.attemptCount,
          lease_id: deliveryState.leaseId,
          ciphertext: deliveryState.state === 'delivered' ? null : encrypted.ciphertext,
          nonce: deliveryState.state === 'delivered' ? null : encrypted.nonce,
          auth_tag: deliveryState.state === 'delivered' ? null : encrypted.authTag,
          is_due: deliveryState.state === 'pending' || deliveryState.state === 'leased',
        }],
      };
    }
    if (sql.startsWith('INSERT INTO email_verification_tokens')) {
      return { rows: [{ id: tokenId }] };
    }
    if (sql.startsWith('INSERT INTO email_verification_deliveries')) {
      return { rows: [{ id: deliveryId }] };
    }
    if (sql.startsWith('UPDATE email_verification_requests')) return { rows: [{ id: String(values[0]) }] };
    if (sql.startsWith('UPDATE email_verification_deliveries') && sql.includes('attempt_count = attempt_count + 1')) {
      deliveryState.state = 'leased';
      deliveryState.leaseId = String(values[1]);
      deliveryState.attemptCount++;
      return { rows: [{ attempt_count: deliveryState.attemptCount }] };
    }
    if (sql.startsWith('UPDATE email_verification_deliveries')) {
      deliveryState.state = String(values[3]) as typeof deliveryState.state;
      if (deliveryState.state !== 'leased') deliveryState.leaseId = null;
      return { rows: [{ id: deliveryId }] };
    }
    if (sql.startsWith('UPDATE email_verification_tokens')) return { rows: [{ id: tokenId }] };
    throw new Error(`Unexpected worker SQL: ${sql}`);
  });
  return { query, release: vi.fn(), statements };
}

describe('verification email delivery worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockProvider.sendVerificationEmail).mockResolvedValue({ ok: true });
  });

  it('creates the token digest and encrypted delivery in the same transaction as request completion', async () => {
    const client = createClient('request');
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);

    await runEmailVerificationDeliveryCycle();

    const sql = client.statements.map(({ sql: statement }) => statement);
    expect(sql.indexOf('BEGIN')).toBeLessThan(sql.findIndex((statement) => statement.startsWith('INSERT INTO email_verification_tokens')));
    expect(sql.findIndex((statement) => statement.startsWith('INSERT INTO email_verification_tokens')))
      .toBeLessThan(sql.findIndex((statement) => statement.startsWith('INSERT INTO email_verification_deliveries')));
    expect(sql.findIndex((statement) => statement.startsWith('INSERT INTO email_verification_deliveries')))
      .toBeLessThan(sql.findIndex((statement) => statement.startsWith('UPDATE email_verification_requests')));
    expect(sql.at(-1)).toBe('COMMIT');
    const tokenInsert = client.statements.find(({ sql: statement }) => statement.startsWith('INSERT INTO email_verification_tokens'));
    const deliveryInsert = client.statements.find(({ sql: statement }) => statement.startsWith('INSERT INTO email_verification_deliveries'));
    expect(tokenInsert?.values[2]).toMatch(/^[0-9a-f]{64}$/);
    const storedCiphertext = deliveryInsert?.values[1];
    expect(Buffer.isBuffer(storedCiphertext)).toBe(true);
    if (!deliveryInsert
      || !Buffer.isBuffer(storedCiphertext)
      || !Buffer.isBuffer(deliveryInsert?.values[2])
      || !Buffer.isBuffer(deliveryInsert?.values[3])) {
      throw new Error('Encrypted delivery payload was not stored as bytea');
    }
    const rawToken = decryptEmailToken({
      ciphertext: storedCiphertext,
      nonce: deliveryInsert.values[2],
      authTag: deliveryInsert.values[3],
    });
    expect(rawToken).toMatch(new RegExp(`^${tokenId}\\.[0-9a-f]{64}$`));
    expect(tokenInsert?.values[2]).toBe(createHash('sha256').update(rawToken.split('.')[1]).digest('hex'));
    expect(storedCiphertext.toString('utf8')).not.toContain(rawToken);
    expect(mockProvider.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('claims and sends through an attempt-specific lease, with the same provider idempotency identity', async () => {
    const deliveryState: MutableDeliveryState = { state: 'pending', attemptCount: 0, leaseId: null };
    const requestClient = createClient('delivery', {}, deliveryState);
    const claimClient = createClient('delivery', {}, deliveryState);
    const sendClient = createClient('delivery', {}, deliveryState);
    vi.mocked(pool.connect)
      .mockResolvedValueOnce(requestClient as never)
      .mockResolvedValueOnce(claimClient as never)
      .mockResolvedValueOnce(sendClient as never);
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: deliveryId, verification_token_id: tokenId, user_id: userId }] } as never)
      .mockResolvedValue({ rows: [] } as never);

    await runEmailVerificationDeliveryCycle();

    expect(mockProvider.sendVerificationEmail).toHaveBeenCalledWith(
      { recordId: tokenId, recipient: email, rawToken: `${tokenId}.${secret}` },
      expect.any(AbortSignal),
    );
    expect(claimClient.statements.at(-1)?.sql).toBe('COMMIT');
    expect(sendClient.statements.at(-1)?.sql).toBe('COMMIT');
    expect(sendClient.statements.some(({ sql }) => sql.startsWith('UPDATE email_verification_deliveries'))).toBe(true);
  });

  it('does not send when the current token has been revoked', async () => {
    const deliveryState: MutableDeliveryState = { state: 'pending', attemptCount: 0, leaseId: null };
    const requestClient = createClient('delivery', {}, deliveryState);
    const claimClient = createClient('delivery', { tokenRevoked: true }, deliveryState);
    vi.mocked(pool.connect)
      .mockResolvedValueOnce(requestClient as never)
      .mockResolvedValueOnce(claimClient as never);
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: deliveryId, verification_token_id: tokenId, user_id: userId }] } as never)
      .mockResolvedValue({ rows: [] } as never);

    await runEmailVerificationDeliveryCycle();

    expect(mockProvider.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('retries transient provider failures with a persisted bounded jitter delay', async () => {
    const deliveryState: MutableDeliveryState = { state: 'pending', attemptCount: 0, leaseId: null };
    const requestClient = createClient('delivery', {}, deliveryState);
    const claimClient = createClient('delivery', {}, deliveryState);
    const sendClient = createClient('delivery', {}, deliveryState);
    vi.mocked(pool.connect)
      .mockResolvedValueOnce(requestClient as never)
      .mockResolvedValueOnce(claimClient as never)
      .mockResolvedValueOnce(sendClient as never);
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ id: deliveryId, verification_token_id: tokenId, user_id: userId }] } as never)
      .mockResolvedValue({ rows: [] } as never);
    vi.mocked(mockProvider.sendVerificationEmail).mockResolvedValueOnce({ ok: false, reason: 'network', retryable: true });

    await runEmailVerificationDeliveryCycle();

    const retry = sendClient.statements.find(({ sql }) => sql.startsWith('UPDATE email_verification_deliveries'));
    expect(retry?.values[3]).toBe('pending');
    expect(retry?.values[5]).toBe('network');
    expect(Number(retry?.values[6])).toBeGreaterThanOrEqual(8);
    expect(Number(retry?.values[6])).toBeLessThanOrEqual(23);
    expect(deliveryState.leaseId).toBeNull();
  });
});
