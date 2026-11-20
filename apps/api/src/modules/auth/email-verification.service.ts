import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/pool';
import { AppError } from '../../utils/errors';
import { verificationEmailDelivery } from './email-delivery';
import { emailEncryptionConfigured, encryptRequestedEmail } from './email-token-crypto';

const INVALID_LINK = 'This verification link is invalid or expired';

type VerificationTokenRow = {
  id: string;
  user_id: string;
  email: string;
  token_hash: string;
  expires_at: Date | string;
  consumed_at: Date | string | null;
  revoked_at: Date | string | null;
  is_unexpired?: boolean;
};

type UserVerificationRow = {
  id: string;
  email: string;
  email_verified: boolean;
};

type ParsedToken = { id: string; secret: string };

export type VerificationRequestResult =
  | { available: false }
  | { available: true; delivery: 'queued' | 'not_needed' };

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseToken(rawToken: string): ParsedToken | null {
  const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{64})$/.exec(rawToken);
  if (!match) return null;
  return { id: match[1], secret: match[2] };
}

function digest(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

function digestsMatch(secret: string, storedHash: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(storedHash)) return false;
  const expected = Buffer.from(storedHash, 'hex');
  const actual = digest(secret);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function invalidLink(): AppError {
  return new AppError('TOKEN_INVALID', INVALID_LINK, 400);
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the operation error when the connection has already failed.
  }
}

export async function requestEmailVerification(email: string, suppressDelivery = false): Promise<VerificationRequestResult> {
  if (!verificationEmailDelivery || !emailEncryptionConfigured()) return { available: false };
  if (suppressDelivery) return { available: true, delivery: 'not_needed' };

  const normalizedEmail = normalizeEmail(email);
  const encrypted = encryptRequestedEmail(normalizedEmail);
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO email_verification_requests (email_ciphertext, nonce, auth_tag)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [encrypted.ciphertext, encrypted.nonce, encrypted.authTag],
    );
    if (rows.length !== 1) throw new Error('Verification request insert returned an unexpected row count');
    await client.query('COMMIT');
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }

  return { available: true, delivery: 'queued' };
}

export async function confirmEmailVerification(rawToken: string): Promise<void> {
  const parsed = parseToken(rawToken);
  if (!parsed) throw invalidLink();

  const { rows: located } = await pool.query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM email_verification_tokens WHERE id = $1`,
    [parsed.id],
  );
  const location = located[0];
  if (!location) throw invalidLink();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: users } = await client.query<UserVerificationRow>(
      `SELECT id, email, email_verified FROM users WHERE id = $1 FOR UPDATE`,
      [location.user_id],
    );
    const user = users[0];
    if (!user) throw invalidLink();

    const { rows: tokens } = await client.query<VerificationTokenRow>(
      `SELECT id, user_id, email, token_hash, expires_at, consumed_at, revoked_at,
              expires_at > clock_timestamp() AS is_unexpired
       FROM email_verification_tokens
       WHERE id = $1 AND user_id = $2
       FOR UPDATE`,
      [parsed.id, location.user_id],
    );
    const token = tokens[0];
    if (!token
      || !digestsMatch(parsed.secret, token.token_hash)
      || token.consumed_at !== null
      || token.revoked_at !== null
      || token.is_unexpired !== true
      || normalizeEmail(user.email) !== token.email
      || user.email_verified) {
      throw invalidLink();
    }

    const { rows: consumed } = await client.query<{ id: string }>(
      `UPDATE email_verification_tokens
       SET consumed_at = clock_timestamp()
       WHERE id = $1 AND user_id = $2 AND token_hash = $3
         AND consumed_at IS NULL AND revoked_at IS NULL
         AND expires_at > clock_timestamp()
       RETURNING id`,
      [token.id, user.id, token.token_hash],
    );
    if (consumed.length !== 1) throw invalidLink();

    const { rows: verified } = await client.query<{ id: string }>(
      `UPDATE users SET email_verified = TRUE
       WHERE id = $1 AND email = $2 AND email_verified = FALSE
       RETURNING id`,
      [user.id, token.email],
    );
    if (verified.length !== 1) throw invalidLink();

    await client.query('COMMIT');
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
