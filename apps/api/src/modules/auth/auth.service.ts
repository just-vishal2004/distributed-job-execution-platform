import { pool } from '../../db/pool';
import { hashPassword, verifyPassword } from '../../utils/password';
import { signToken } from '../../utils/token';
import { AppError, conflict } from '../../utils/errors';
import { env } from '../../config/env';
import type { RegisterInput, LoginInput } from './auth.schemas';
import type { AuthUser } from '@meridian/types';

interface RegisterResult {
  user: AuthUser;
  token: string;
  sessionId: string;
}

export async function register(input: RegisterInput): Promise<RegisterResult> {
  const { email, password, name, role } = input;

  const { rows: existing } = await pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );

  if (existing.length > 0) {
    throw conflict('An account with this email already exists');
  }

  const passwordHash = await hashPassword(password);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: userRows } = await client.query<{
      id: string;
      email: string;
      role: string;
      created_at: Date;
    }>(
      `INSERT INTO users (email, password_hash, role)
       VALUES ($1, $2, $3)
       RETURNING id, email, role, created_at`,
      [email, passwordHash, role],
    );
    const userRow = userRows[0];

    await client.query(
      `INSERT INTO profiles (user_id, name) VALUES ($1, $2)`,
      [userRow.id, name],
    );

    const expiresAt = sessionExpiresAt();
    const { rows: sessionRows } = await client.query<{ id: string }>(
      `INSERT INTO sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id`,
      [userRow.id, expiresAt],
    );
    const sessionId = sessionRows[0].id;

    await client.query('COMMIT');

    const user: AuthUser = {
      id: userRow.id,
      email: userRow.email,
      role: userRow.role as AuthUser['role'],
      name,
    };

    const token = signToken({ sub: user.id, jti: sessionId, role: user.role });

    return { user, token, sessionId };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

interface LoginResult {
  user: AuthUser;
  token: string;
  sessionId: string;
}

export async function login(input: LoginInput): Promise<LoginResult> {
  const { email, password } = input;

  const { rows } = await pool.query<{
    id: string;
    email: string;
    password_hash: string;
    role: string;
  }>(
    `SELECT id, email, password_hash, role FROM users WHERE email = $1`,
    [email],
  );

  const SENTINEL_HASH =
    '$2a$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const passwordHash = rows[0]?.password_hash ?? SENTINEL_HASH;
  const isValid = await verifyPassword(password, passwordHash);

  if (rows.length === 0 || !isValid) {
    throw new AppError('INVALID_CREDENTIALS', 'Invalid email or password', 401);
  }

  const userRow = rows[0];

  const { rows: profileRows } = await pool.query<{ name: string }>(
    `SELECT name FROM profiles WHERE user_id = $1`,
    [userRow.id],
  );
  const name = profileRows[0]?.name ?? '';

  const expiresAt = sessionExpiresAt();
  const { rows: sessionRows } = await pool.query<{ id: string }>(
    `INSERT INTO sessions (user_id, expires_at) VALUES ($1, $2) RETURNING id`,
    [userRow.id, expiresAt],
  );
  const sessionId = sessionRows[0].id;

  const user: AuthUser = {
    id: userRow.id,
    email: userRow.email,
    role: userRow.role as AuthUser['role'],
    name,
  };

  const token = signToken({ sub: user.id, jti: sessionId, role: user.role });

  return { user, token, sessionId };
}

export async function logout(sessionId: string): Promise<void> {
  await pool.query(
    `UPDATE sessions SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId],
  );
}

export async function getMe(userId: string): Promise<AuthUser> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    role: string;
    name: string;
  }>(
    `SELECT u.id, u.email, u.role, p.name
     FROM users u
     INNER JOIN profiles p ON p.user_id = u.id
     WHERE u.id = $1`,
    [userId],
  );

  if (rows.length === 0) {
    throw new AppError('NOT_FOUND', 'User not found', 404);
  }

  const row = rows[0];
  return {
    id: row.id,
    email: row.email,
    role: row.role as AuthUser['role'],
    name: row.name,
  };
}

function sessionExpiresAt(): Date {
  const expiresIn = env.JWT_EXPIRES_IN;
  const match = expiresIn.match(/^(\d+)([dhm])$/);

  if (!match) {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return date;
  }

  const [, amount, unit] = match;
  const ms =
    parseInt(amount) *
    (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : 60_000);

  return new Date(Date.now() + ms);
}
