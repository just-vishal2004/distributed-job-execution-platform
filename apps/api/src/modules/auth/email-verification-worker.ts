import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/pool';
import { logger } from '../../utils/logger';
import { verificationEmailDelivery } from './email-delivery';
import {
  decryptEmailToken,
  decryptRequestedEmail,
  encryptEmailToken,
  type EncryptedEmailToken,
} from './email-token-crypto';

const MAX_ATTEMPTS = 5;
const DELIVERY_TIMEOUT_MS = 5_000;
const LEASE_SECONDS = 30;
const BATCH_SIZE = 20;
const CYCLE_INTERVAL_MS = 1_000;
type DeliveryState = 'pending' | 'leased' | 'delivered' | 'failed' | 'cancelled';

type EncryptedRow = {
  ciphertext: Buffer | null;
  nonce: Buffer | null;
  auth_tag: Buffer | null;
};

type UserRow = { id: string; email: string; email_verified: boolean };
type TokenRow = {
  id: string;
  email: string;
  token_hash: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
  is_unexpired: boolean;
};

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the original operation error.
  }
}

async function beginWorkerTransaction(client: PoolClient): Promise<void> {
  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout = '5s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
}

function encryptedPayload(row: EncryptedRow): EncryptedEmailToken | null {
  if (!row.ciphertext || !row.nonce || !row.auth_tag) return null;
  return { ciphertext: row.ciphertext, nonce: row.nonce, authTag: row.auth_tag };
}

function normalizedEmail(email: string): string {
  return email.trim().toLowerCase();
}

function rawTokenMatches(rawToken: string, token: TokenRow): boolean {
  const prefix = `${token.id}.`;
  if (!rawToken.startsWith(prefix)) return false;
  const secret = rawToken.slice(prefix.length);
  if (!/^[0-9a-f]{64}$/.test(secret) || !/^[0-9a-f]{64}$/.test(token.token_hash)) return false;
  const actual = createHash('sha256').update(secret).digest();
  const expected = Buffer.from(token.token_hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function markRequestTerminal(
  client: PoolClient,
  requestId: string,
  state: 'processed' | 'not_needed' | 'failed',
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE email_verification_requests
     SET state = $2, email_ciphertext = NULL, nonce = NULL, auth_tag = NULL,
         processed_at = clock_timestamp()
     WHERE id = $1 AND state = 'pending'
     RETURNING id`,
    [requestId, state],
  );
  if (rows.length !== 1) throw new Error('Verification request state changed unexpectedly');
}

async function processOneVerificationRequest(): Promise<boolean> {
  const client = await pool.connect();
  try {
    await beginWorkerTransaction(client);
    const { rows: requests } = await client.query<{ id: string; ciphertext: Buffer; nonce: Buffer; auth_tag: Buffer }>(
      `SELECT id, email_ciphertext AS ciphertext, nonce, auth_tag
       FROM email_verification_requests
       WHERE state = 'pending'
       ORDER BY created_at, id
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
    );
    const request = requests[0];
    if (!request) {
      await client.query('COMMIT');
      return false;
    }

    let email: string;
    try {
      email = normalizedEmail(decryptRequestedEmail({
        ciphertext: request.ciphertext,
        nonce: request.nonce,
        authTag: request.auth_tag,
      }));
    } catch {
      await markRequestTerminal(client, request.id, 'failed');
      await client.query('COMMIT');
      logger.warn('Verification request could not be decrypted', { event: 'email_verification_request_failed' });
      return true;
    }

    const { rows: users } = await client.query<UserRow>(
      `SELECT id, email, email_verified FROM users WHERE email = $1 FOR UPDATE`,
      [email],
    );
    const user = users[0];
    if (!user || user.email_verified) {
      await markRequestTerminal(client, request.id, 'not_needed');
      await client.query('COMMIT');
      return true;
    }

    const { rows: previousTokens } = await client.query<{ id: string }>(
      `SELECT id FROM email_verification_tokens
       WHERE user_id = $1 AND email = $2 AND consumed_at IS NULL AND revoked_at IS NULL
       ORDER BY id FOR UPDATE`,
      [user.id, user.email],
    );
    const previousIds = previousTokens.map(({ id }) => id);
    if (previousIds.length > 0) {
      const { rows: revoked } = await client.query<{ id: string }>(
        `UPDATE email_verification_tokens
         SET revoked_at = clock_timestamp()
         WHERE id = ANY($1::uuid[]) AND consumed_at IS NULL AND revoked_at IS NULL
         RETURNING id`,
        [previousIds],
      );
      if (revoked.length !== previousIds.length) throw new Error('Verification token state changed unexpectedly');
      await client.query(
        `UPDATE email_verification_deliveries
         SET state = 'cancelled', ciphertext = NULL, nonce = NULL, auth_tag = NULL,
             lease_id = NULL, lease_expires_at = NULL, terminal_at = clock_timestamp()
         WHERE verification_token_id = ANY($1::uuid[]) AND state IN ('pending', 'leased')`,
        [previousIds],
      );
    }

    const secret = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(secret).digest('hex');
    const { rows: tokens } = await client.query<{ id: string }>(
      `INSERT INTO email_verification_tokens (user_id, email, token_hash, expires_at)
       VALUES ($1, $2, $3, clock_timestamp() + INTERVAL '24 hours')
       RETURNING id`,
      [user.id, user.email, tokenHash],
    );
    const token = tokens[0];
    if (!token) throw new Error('Verification token insert returned no row');
    const encrypted = encryptEmailToken(`${token.id}.${secret}`);
    const { rows: deliveries } = await client.query<{ id: string }>(
      `INSERT INTO email_verification_deliveries
         (verification_token_id, ciphertext, nonce, auth_tag)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [token.id, encrypted.ciphertext, encrypted.nonce, encrypted.authTag],
    );
    if (deliveries.length !== 1) throw new Error('Verification delivery insert returned an unexpected row count');
    await markRequestTerminal(client, request.id, 'processed');
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

type DeliveryCandidate = { id: string; verification_token_id: string; user_id: string };

async function lockDeliveryContext(
  client: PoolClient,
  candidate: DeliveryCandidate,
): Promise<{ user: UserRow | undefined; token: TokenRow | undefined; delivery: (EncryptedRow & { id: string; state: DeliveryState; attempt_count: number; lease_id: string | null; is_due: boolean }) | undefined }> {
  const { rows: users } = await client.query<UserRow>(
    'SELECT id, email, email_verified FROM users WHERE id = $1 FOR UPDATE',
    [candidate.user_id],
  );
  const user = users[0];
  const { rows: tokens } = await client.query<TokenRow>(
    `SELECT id, email, token_hash, expires_at, consumed_at, revoked_at,
            expires_at > clock_timestamp() AS is_unexpired
     FROM email_verification_tokens WHERE id = $1 AND user_id = $2 FOR UPDATE`,
    [candidate.verification_token_id, candidate.user_id],
  );
  const { rows: deliveries } = await client.query<{
    id: string;
    state: DeliveryState;
    attempt_count: number;
    lease_id: string | null;
    ciphertext: Buffer | null;
    nonce: Buffer | null;
    auth_tag: Buffer | null;
    is_due: boolean;
  }>(
    `SELECT id, state, attempt_count, lease_id, ciphertext, nonce, auth_tag,
            (state = 'pending' AND available_at <= clock_timestamp())
              OR (state = 'leased' AND lease_expires_at <= clock_timestamp()) AS is_due
     FROM email_verification_deliveries
     WHERE id = $1 AND verification_token_id = $2
     FOR UPDATE SKIP LOCKED`,
    [candidate.id, candidate.verification_token_id],
  );
  const delivery = deliveries[0];
  return { user, token: tokens[0], delivery };
}

function tokenIsActive(user: UserRow | undefined, token: TokenRow | undefined): token is TokenRow {
  return user !== undefined
    && token !== undefined
    && !user.email_verified
    && normalizedEmail(user.email) === token.email
    && token.consumed_at === null
    && token.revoked_at === null
    && token.is_unexpired;
}

async function updateDelivery(
  client: PoolClient,
  deliveryId: string,
  expectedState: 'pending' | 'leased',
  expectedLeaseId: string | null,
  state: 'delivered' | 'failed' | 'cancelled' | 'pending',
  failureKind: 'provider' | 'network' | null,
  retrySeconds?: number,
): Promise<void> {
  const terminal = state !== 'pending';
  const { rows } = await client.query<{ id: string }>(
    `UPDATE email_verification_deliveries
     SET state = $4,
         ciphertext = CASE WHEN $5 THEN NULL ELSE ciphertext END,
         nonce = CASE WHEN $5 THEN NULL ELSE nonce END,
         auth_tag = CASE WHEN $5 THEN NULL ELSE auth_tag END,
         lease_id = NULL,
         lease_expires_at = NULL,
         available_at = CASE WHEN $4 = 'pending'
           THEN clock_timestamp() + ($7::integer * INTERVAL '1 second') ELSE available_at END,
         delivered_at = CASE WHEN $4 = 'delivered' THEN clock_timestamp() ELSE NULL END,
         terminal_at = CASE WHEN $5 THEN clock_timestamp() ELSE NULL END,
         last_failure_kind = $6
     WHERE id = $1 AND state = $2 AND lease_id IS NOT DISTINCT FROM $3
     RETURNING id`,
    [deliveryId, expectedState, expectedLeaseId, state, terminal, failureKind, retrySeconds ?? 0],
  );
  if (rows.length !== 1) throw new Error('Verification delivery lease was lost');
}

async function claimDelivery(candidate: DeliveryCandidate): Promise<{ leaseId: string; attempt: number } | null> {
  const client = await pool.connect();
  try {
    await beginWorkerTransaction(client);
    const context = await lockDeliveryContext(client, candidate);
    const { user, token, delivery } = context;
    if (!delivery || !delivery.is_due || delivery.state === 'delivered' || delivery.state === 'failed' || delivery.state === 'cancelled') {
      await client.query('COMMIT');
      return null;
    }
    if (!tokenIsActive(user, token)) {
      await updateDelivery(client, delivery.id, delivery.state, delivery.lease_id, 'cancelled', null);
      await client.query('COMMIT');
      return null;
    }
    if (delivery.attempt_count >= MAX_ATTEMPTS) {
      await updateDelivery(client, delivery.id, delivery.state, delivery.lease_id, 'failed', delivery.state === 'leased' ? 'network' : null);
      await client.query('COMMIT');
      return null;
    }

    const leaseId = randomUUID();
    const { rows } = await client.query<{ attempt_count: number }>(
      `UPDATE email_verification_deliveries
       SET state = 'leased', attempt_count = attempt_count + 1,
           lease_id = $2, lease_expires_at = clock_timestamp() + ($3::integer * INTERVAL '1 second')
       WHERE id = $1 AND state = $4
       RETURNING attempt_count`,
      [delivery.id, leaseId, LEASE_SECONDS, delivery.state],
    );
    if (rows.length !== 1) throw new Error('Verification delivery claim affected an unexpected row count');
    await client.query('COMMIT');
    return { leaseId, attempt: rows[0].attempt_count };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

async function sendClaimedDelivery(candidate: DeliveryCandidate, leaseId: string, attempt: number): Promise<void> {
  const deliveryProvider = verificationEmailDelivery;
  if (!deliveryProvider) return;
  const client = await pool.connect();
  try {
    await beginWorkerTransaction(client);
    const { user, token, delivery } = await lockDeliveryContext(client, candidate);
    if (!delivery || delivery.state !== 'leased' || delivery.lease_id !== leaseId) {
      await client.query('COMMIT');
      return;
    }
    if (!user || !tokenIsActive(user, token)) {
      await updateDelivery(client, delivery.id, 'leased', leaseId, 'cancelled', null);
      await client.query('COMMIT');
      return;
    }

    const encrypted = encryptedPayload(delivery);
    if (!encrypted) {
      await updateDelivery(client, delivery.id, 'leased', leaseId, 'failed', 'provider');
      await client.query('COMMIT');
      logger.warn('Verification delivery payload is unavailable', { event: 'email_verification_delivery_failed' });
      return;
    }

    let rawToken: string;
    try {
      rawToken = decryptEmailToken(encrypted);
    } catch {
      await updateDelivery(client, delivery.id, 'leased', leaseId, 'failed', 'provider');
      await client.query('COMMIT');
      logger.warn('Verification delivery payload could not be decrypted', { event: 'email_verification_delivery_failed' });
      return;
    }
    if (!rawTokenMatches(rawToken, token)) {
      await updateDelivery(client, delivery.id, 'leased', leaseId, 'failed', 'provider');
      await client.query('COMMIT');
      logger.warn('Verification delivery payload did not match its token', { event: 'email_verification_delivery_failed' });
      return;
    }

    const result = await deliveryProvider.sendVerificationEmail(
      { recordId: token.id, recipient: user.email, rawToken },
      AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    ).catch(() => ({ ok: false as const, reason: 'network' as const, retryable: true }));

    if (result.ok) {
      await updateDelivery(client, delivery.id, 'leased', leaseId, 'delivered', null);
    } else if (!result.retryable || attempt >= MAX_ATTEMPTS) {
      await updateDelivery(client, delivery.id, 'leased', leaseId, 'failed', result.reason === 'provider' ? 'provider' : 'network');
    } else {
      const baseSeconds = Math.min(15 * (2 ** (attempt - 1)), 120);
      const jitteredSeconds = Math.max(1, Math.round(baseSeconds * (0.5 + Math.random())));
      await updateDelivery(client, delivery.id, 'leased', leaseId, 'pending', result.reason === 'provider' ? 'provider' : 'network', jitteredSeconds);
    }
    await client.query('COMMIT');
  } catch (error) {
    await rollback(client);
    logger.warn('Verification delivery attempt failed', { event: 'email_verification_delivery_attempt_failed' });
  } finally {
    client.release();
  }
}

async function processOneVerificationDelivery(): Promise<boolean> {
  const { rows: candidates } = await pool.query<DeliveryCandidate>(
    `SELECT delivery.id, delivery.verification_token_id, token.user_id
     FROM email_verification_deliveries AS delivery
     JOIN email_verification_tokens AS token ON token.id = delivery.verification_token_id
     WHERE (delivery.state = 'pending' AND delivery.available_at <= clock_timestamp())
        OR (delivery.state = 'leased' AND delivery.lease_expires_at <= clock_timestamp())
     ORDER BY COALESCE(delivery.lease_expires_at, delivery.available_at), delivery.created_at, delivery.id
     LIMIT 1`,
  );
  const candidate = candidates[0];
  if (!candidate) return false;
  const claim = await claimDelivery(candidate);
  if (claim) await sendClaimedDelivery(candidate, claim.leaseId, claim.attempt);
  return true;
}

async function cleanupTerminalEmailWork(): Promise<void> {
  await pool.query(
    `WITH old_rows AS (
       SELECT id FROM email_verification_requests
       WHERE state <> 'pending' AND processed_at < clock_timestamp() - INTERVAL '30 days'
       ORDER BY processed_at, id LIMIT 500
     )
     DELETE FROM email_verification_requests AS request
     USING old_rows WHERE request.id = old_rows.id`,
  );
  await pool.query(
    `WITH old_rows AS (
       SELECT id FROM email_verification_deliveries
       WHERE state IN ('delivered', 'failed', 'cancelled')
         AND terminal_at < clock_timestamp() - INTERVAL '30 days'
       ORDER BY terminal_at, id LIMIT 500
     )
     DELETE FROM email_verification_deliveries AS delivery
     USING old_rows WHERE delivery.id = old_rows.id`,
  );
}

let loopRunning = false;

export async function runEmailVerificationDeliveryCycle(): Promise<void> {
  if (!verificationEmailDelivery || loopRunning) return;
  loopRunning = true;
  try {
    for (let index = 0; index < BATCH_SIZE; index++) {
      let hadRequest: boolean;
      try {
        hadRequest = await processOneVerificationRequest();
      } catch {
        logger.warn('Verification request processing failed', { event: 'email_verification_request_processing_failed' });
        break;
      }
      if (!hadRequest) break;
    }
    for (let index = 0; index < BATCH_SIZE; index++) {
      let hadDelivery: boolean;
      try {
        hadDelivery = await processOneVerificationDelivery();
      } catch {
        logger.warn('Verification delivery processing failed', { event: 'email_verification_delivery_processing_failed' });
        break;
      }
      if (!hadDelivery) break;
    }
    try {
      await cleanupTerminalEmailWork();
    } catch {
      logger.warn('Verification email work cleanup failed', { event: 'email_verification_cleanup_failed' });
    }
  } finally {
    loopRunning = false;
  }
}

export function startEmailVerificationDeliveryWorker(): void {
  if (!verificationEmailDelivery) {
    logger.info('Verification email delivery worker is disabled because the provider is not configured');
    return;
  }
  logger.info('Verification email delivery worker started', { intervalMs: CYCLE_INTERVAL_MS });
  setInterval(() => void runEmailVerificationDeliveryCycle(), CYCLE_INTERVAL_MS);
}
