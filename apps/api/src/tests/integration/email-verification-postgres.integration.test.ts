import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const fakeProvider = vi.hoisted(() => ({
  sendVerificationEmail: vi.fn(async (
    _message: { recordId: string; recipient: string; rawToken: string },
    _signal?: AbortSignal,
  ): Promise<{ ok: true } | { ok: false; reason: 'provider' | 'network'; retryable: boolean }> => ({ ok: true })),
}));

vi.mock('../../modules/auth/email-delivery', () => ({ verificationEmailDelivery: fakeProvider }));

import { pool } from '../../db/pool';
import { verificationConfirmationRateLimit, verificationRequestRateLimit } from '../../middleware/emailVerificationRateLimit';
import { requestEmailVerification, confirmEmailVerification } from '../../modules/auth/email-verification.service';
import { runEmailVerificationDeliveryCycle } from '../../modules/auth/email-verification-worker';
import { decryptEmailToken, encryptEmailToken } from '../../modules/auth/email-token-crypto';

const enabled = process.env.EMAIL_VERIFICATION_PG_INTEGRATION === '1';
const describePostgres = enabled ? describe : describe.skip;
let fakeProviderServer: Server | undefined;
let fakeProviderUrl = '';
let holdFakeProviderResponses = false;
const pendingFakeResponses: ServerResponse[] = [];
const fakeProviderReceipts: Array<{ recordId: string; idempotencyKey: string | null }> = [];

const workerProcessScript = `
  const Module = require('node:module');
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === './email-delivery' && String(parent && parent.filename).includes('email-verification-worker')) {
      return { verificationEmailDelivery: { sendVerificationEmail: async (message, signal) => {
        const mode = process.env.EMAIL_WORKER_FAKE_MODE;
        if (mode === 'crash-before-provider') process.exit(41);
        if (mode === 'provider-rejection') return { ok: false, reason: 'provider', retryable: false };
        if (mode === 'connection-failure') throw new Error('controlled fake connection failure');
        if (mode === 'timeout') return new Promise((resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('controlled fake timeout')), { once: true });
        });
        const response = await fetch(process.env.EMAIL_WORKER_FAKE_PROVIDER_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'idempotency-key': 'email-verification/' + message.recordId },
          body: JSON.stringify({ recordId: message.recordId }),
          signal,
        });
        if (!response.ok) return { ok: false, reason: 'network', retryable: true };
        if (mode === 'crash-after-provider-acceptance') process.exit(42);
        return { ok: true };
      } } };
    }
    return Reflect.apply(originalLoad, this, [request, parent, isMain]);
  };
  require('./src/modules/auth/email-verification-worker').runEmailVerificationDeliveryCycle()
    .then(async () => { await require('./src/db/pool').pool.end(); })
    .catch(async () => { await require('./src/db/pool').pool.end(); process.exitCode = 1; });
`;

function runWorkerProcess(mode: string): Promise<number | null> {
  const child = spawn(process.execPath, ['-r', 'tsx/cjs', '-e', workerProcessScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      EMAIL_WORKER_FAKE_MODE: mode,
      EMAIL_WORKER_FAKE_PROVIDER_URL: fakeProviderUrl,
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

async function waitForFakeReceipts(expected: number): Promise<void> {
  for (let attempt = 0; attempt < 500 && fakeProviderReceipts.length < expected; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(fakeProviderReceipts.length).toBe(expected);
}

function releaseFakeProviderResponses(): void {
  holdFakeProviderResponses = false;
  for (const response of pendingFakeResponses.splice(0)) {
    response.statusCode = 200;
    response.end(JSON.stringify({ id: 'fake-provider-accepted' }));
  }
}

function mockRequest(ip: string, body: unknown): Request {
  return { ip, body, socket: { remoteAddress: ip } } as Request;
}

async function runMiddleware(
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>,
  request: Request,
): Promise<unknown> {
  let error: unknown;
  await middleware(request, {} as Response, (nextError?: unknown) => { error = nextError; });
  return error;
}

async function createUser(email: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users(email, password_hash) VALUES ($1, 'integration-test-only') RETURNING id`,
    [email],
  );
  return rows[0].id;
}

async function createPendingDelivery(email: string): Promise<{ tokenId: string; rawToken: string }> {
  const userId = await createUser(email);
  const tokenId = randomUUID();
  const secret = randomBytes(32).toString('hex');
  const rawToken = `${tokenId}.${secret}`;
  const encrypted = encryptEmailToken(rawToken);
  await pool.query(
    `INSERT INTO email_verification_tokens(id, user_id, email, token_hash, expires_at)
     VALUES ($1, $2, $3, $4, clock_timestamp() + interval '1 hour')`,
    [tokenId, userId, email, createHash('sha256').update(secret).digest('hex')],
  );
  await pool.query(
    `INSERT INTO email_verification_deliveries(verification_token_id, ciphertext, nonce, auth_tag)
     VALUES ($1, $2, $3, $4)`,
    [tokenId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag],
  );
  return { tokenId, rawToken };
}

describePostgres('email verification PostgreSQL integration', () => {
  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL ?? '');
    if (target.hostname !== '127.0.0.1' || target.port !== '55435' || target.pathname !== '/phase3c5d5') {
      throw new Error('Integration tests require the isolated phase3c5d5 database on loopback port 55435');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      const { rows } = await client.query<{
        database_name: string;
        role_name: string;
        version_num: string;
        transaction_read_only: string;
        is_superuser: boolean;
      }>(
        `SELECT current_database() AS database_name,
                current_user AS role_name,
                current_setting('server_version_num') AS version_num,
                current_setting('transaction_read_only') AS transaction_read_only,
                role.rolsuper AS is_superuser
         FROM pg_roles role WHERE role.rolname = current_user`,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].database_name).toBe('phase3c5d5');
      expect(rows[0].role_name).toBe('phase3c5d5_app');
      expect(Number(rows[0].version_num)).toBeGreaterThanOrEqual(160000);
      expect(Number(rows[0].version_num)).toBeLessThan(170000);
      expect(rows[0].transaction_read_only).toBe('on');
      expect(rows[0].is_superuser).toBe(false);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    if (process.env.UNSCOPED_QUEUE_ENABLED === 'true') {
      throw new Error('Integration tests require the global queue to remain disabled');
    }

    fakeProviderServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      request.on('end', () => {
        let recordId: string | null = null;
        try {
          const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (typeof payload === 'object' && payload !== null && 'recordId' in payload
            && typeof payload.recordId === 'string') recordId = payload.recordId;
        } catch {
          response.statusCode = 400;
          response.end();
          return;
        }
        if (!recordId) {
          response.statusCode = 400;
          response.end();
          return;
        }
        const idempotencyKey = request.headers['idempotency-key'];
        fakeProviderReceipts.push({
          recordId,
          idempotencyKey: Array.isArray(idempotencyKey) ? idempotencyKey[0] ?? null : idempotencyKey ?? null,
        });
        if (holdFakeProviderResponses) pendingFakeResponses.push(response);
        else {
          response.statusCode = 200;
          response.end(JSON.stringify({ id: 'fake-provider-accepted' }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      fakeProviderServer?.once('error', reject);
      fakeProviderServer?.listen(0, '127.0.0.1', () => {
        const address = fakeProviderServer?.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Fake provider did not bind a TCP port'));
          return;
        }
        fakeProviderUrl = `http://127.0.0.1:${address.port}/send`;
        resolve();
      });
    });
  });

  beforeEach(async () => {
    fakeProvider.sendVerificationEmail.mockReset();
    fakeProvider.sendVerificationEmail.mockResolvedValue({ ok: true });
    fakeProviderReceipts.length = 0;
    releaseFakeProviderResponses();
    await pool.query('TRUNCATE email_verification_requests, email_verification_deliveries, email_verification_tokens, email_verification_rate_limits, users CASCADE');
  });

  afterAll(async () => {
    releaseFakeProviderResponses();
    if (fakeProviderServer) await new Promise<void>((resolve) => fakeProviderServer?.close(() => resolve()));
    await pool.end();
  });

  it('processes a queued request through a fake provider and persists only a digest', async () => {
    const email = `pg-${randomUUID()}@example.test`;
    await createUser(email);
    await expect(requestEmailVerification(email)).resolves.toEqual({ available: true, delivery: 'queued' });

    await runEmailVerificationDeliveryCycle();

    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(1);
    const sent = fakeProvider.sendVerificationEmail.mock.calls[0][0];
    const { rows } = await pool.query<{
      state: string;
      token_hash: string;
      ciphertext: Buffer | null;
      stored_token_count: number;
    }>(
      `SELECT delivery.state, token.token_hash, delivery.ciphertext,
              (SELECT count(*)::integer FROM email_verification_tokens WHERE token_hash = $2) AS stored_token_count
       FROM email_verification_deliveries delivery
       JOIN email_verification_tokens token ON token.id = delivery.verification_token_id
       WHERE token.id = $1`,
      [sent.recordId, createHash('sha256').update(sent.rawToken.split('.')[1]).digest('hex')],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('delivered');
    expect(rows[0].token_hash).toBe(createHash('sha256').update(sent.rawToken.split('.')[1]).digest('hex'));
    expect(rows[0].ciphertext).toBeNull();
    expect(rows[0].stored_token_count).toBe(1);
  });

  it('cancels an older request before sending the latest token and rejects confirmation replay', async () => {
    const email = `replace-${randomUUID()}@example.test`;
    await createUser(email);
    await Promise.all([requestEmailVerification(email), requestEmailVerification(email)]);

    await runEmailVerificationDeliveryCycle();

    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(1);
    const { rawToken } = fakeProvider.sendVerificationEmail.mock.calls[0][0];
    const { rows } = await pool.query<{ state: string; revoked_at: Date | null }>(
      `SELECT delivery.state, token.revoked_at
       FROM email_verification_deliveries delivery
       JOIN email_verification_tokens token ON token.id = delivery.verification_token_id
       ORDER BY token.created_at, token.id`,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe('cancelled');
    expect(rows[0].revoked_at).not.toBeNull();
    expect(rows[1].state).toBe('delivered');
    await expect(confirmEmailVerification(rawToken)).resolves.toBeUndefined();
    await expect(confirmEmailVerification(rawToken)).rejects.toMatchObject({ code: 'TOKEN_INVALID' });
  });

  it('serializes request replacement behind a provider call already holding the token locks', async () => {
    const email = `race-${randomUUID()}@example.test`;
    await createPendingDelivery(email);
    let releaseProvider: () => void = () => undefined;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    fakeProvider.sendVerificationEmail.mockImplementationOnce(async () => {
      await providerGate;
      return { ok: true };
    });

    const firstWorker = runEmailVerificationDeliveryCycle();
    for (let attempt = 0; attempt < 100 && fakeProvider.sendVerificationEmail.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(1);
    const firstRecordId = fakeProvider.sendVerificationEmail.mock.calls[0][0].recordId;
    await requestEmailVerification(email);

    vi.resetModules();
    const secondWorker = await import('../../modules/auth/email-verification-worker');
    const secondPoolModule = await import('../../db/pool');
    const secondCycle = secondWorker.runEmailVerificationDeliveryCycle();
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseProvider();
    await Promise.all([firstWorker, secondCycle]);

    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(2);
    const latestRecordId = fakeProvider.sendVerificationEmail.mock.calls[1][0].recordId;
    expect(latestRecordId).not.toBe(firstRecordId);
    const { rows } = await pool.query<{ id: string; revoked_at: Date | null; state: string }>(
      `SELECT token.id, token.revoked_at, delivery.state
       FROM email_verification_tokens token
       JOIN email_verification_deliveries delivery ON delivery.verification_token_id = token.id
       WHERE token.email = $1 ORDER BY token.created_at, token.id`,
      [email],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: firstRecordId, revoked_at: expect.any(Date), state: 'delivered' });
    expect(rows[1]).toEqual({ id: latestRecordId, revoked_at: null, state: 'delivered' });
    await expect(confirmEmailVerification(fakeProvider.sendVerificationEmail.mock.calls[0][0].rawToken))
      .rejects.toMatchObject({ code: 'TOKEN_INVALID' });
    await expect(confirmEmailVerification(fakeProvider.sendVerificationEmail.mock.calls[1][0].rawToken)).resolves.toBeUndefined();
    await secondPoolModule.pool.end();
  });

  it('marks an unreadable encrypted delivery failed without calling the provider', async () => {
    const email = `tamper-${randomUUID()}@example.test`;
    const userId = await createUser(email);
    const tokenId = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const encrypted = encryptEmailToken(`${tokenId}.${secret}`);
    encrypted.authTag = Buffer.from(encrypted.authTag);
    encrypted.authTag[0] ^= 1;
    await pool.query(
      `INSERT INTO email_verification_tokens(id, user_id, email, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + interval '1 hour')`,
      [tokenId, userId, email, createHash('sha256').update(secret).digest('hex')],
    );
    await pool.query(
      `INSERT INTO email_verification_deliveries(verification_token_id, ciphertext, nonce, auth_tag)
       VALUES ($1, $2, $3, $4)`,
      [tokenId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag],
    );

    await runEmailVerificationDeliveryCycle();

    const { rows } = await pool.query<{ state: string; ciphertext: Buffer | null }>(
      'SELECT state, ciphertext FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(rows[0]).toEqual({ state: 'failed', ciphertext: null });
    expect(fakeProvider.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('recovers an expired claim and keeps the provider id stable across retry', async () => {
    const email = `retry-${randomUUID()}@example.test`;
    const userId = await createUser(email);
    const tokenId = randomUUID();
    const secret = randomBytes(32).toString('hex');
    const encrypted = encryptEmailToken(`${tokenId}.${secret}`);
    await pool.query(
      `INSERT INTO email_verification_tokens(id, user_id, email, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, clock_timestamp() + interval '1 hour')`,
      [tokenId, userId, email, createHash('sha256').update(secret).digest('hex')],
    );
    await pool.query(
      `INSERT INTO email_verification_deliveries
         (verification_token_id, ciphertext, nonce, auth_tag, state, attempt_count, lease_id, lease_expires_at)
       VALUES ($1, $2, $3, $4, 'leased', 1, $5, clock_timestamp() - interval '1 second')`,
      [tokenId, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, randomUUID()],
    );

    await runEmailVerificationDeliveryCycle();

    const { rows } = await pool.query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(rows[0]).toEqual({ state: 'delivered', attempt_count: 2 });
    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(1);
    expect(fakeProvider.sendVerificationEmail.mock.calls[0][0].recordId).toBe(tokenId);
  });

  it('serializes two independent worker instances competing for the same delivery', async () => {
    const email = `compete-${randomUUID()}@example.test`;
    const { tokenId } = await createPendingDelivery(email);
    let releaseProvider: () => void = () => undefined;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    fakeProvider.sendVerificationEmail.mockImplementationOnce(async () => {
      await providerGate;
      return { ok: true };
    });

    const firstWorker = runEmailVerificationDeliveryCycle();
    for (let attempt = 0; attempt < 100 && fakeProvider.sendVerificationEmail.mock.calls.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(1);

    vi.resetModules();
    const secondWorker = await import('../../modules/auth/email-verification-worker');
    const secondPoolModule = await import('../../db/pool');
    await secondWorker.runEmailVerificationDeliveryCycle();
    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(1);

    releaseProvider();
    await firstWorker;
    const { rows } = await pool.query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(rows[0]).toEqual({ state: 'delivered', attempt_count: 1 });
    await secondPoolModule.pool.end();
  });

  it('serializes independent operating-system worker processes on one delivery', async () => {
    const email = `process-race-${randomUUID()}@example.test`;
    const { tokenId } = await createPendingDelivery(email);
    holdFakeProviderResponses = true;
    const firstProcess = runWorkerProcess('success');
    await waitForFakeReceipts(1);
    const secondProcess = runWorkerProcess('success');
    const secondExit = await secondProcess;
    expect(secondExit).toBe(0);
    expect(fakeProviderReceipts).toHaveLength(1);
    releaseFakeProviderResponses();
    expect(await firstProcess).toBe(0);

    const { rows } = await pool.query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(rows[0]).toEqual({ state: 'delivered', attempt_count: 1 });
    expect(fakeProviderReceipts[0]).toEqual({
      recordId: tokenId,
      idempotencyKey: `email-verification/${tokenId}`,
    });
  });

  it('recovers a delivery after an OS worker exits after claim but before provider call', async () => {
    const email = `process-crash-before-${randomUUID()}@example.test`;
    const { tokenId } = await createPendingDelivery(email);
    expect(await runWorkerProcess('crash-before-provider')).toBe(41);
    expect(fakeProviderReceipts).toHaveLength(0);

    const claimed = await pool.query<{ lease_id: string; attempt_count: number; state: string }>(
      'SELECT lease_id, attempt_count, state FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(claimed.rows[0].state).toBe('leased');
    expect(claimed.rows[0].attempt_count).toBe(1);
    const staleLeaseId = claimed.rows[0].lease_id;
    await pool.query(
      `UPDATE email_verification_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE verification_token_id = $1`,
      [tokenId],
    );

    expect(await runWorkerProcess('success')).toBe(0);
    const recovered = await pool.query<{ state: string; attempt_count: number; lease_id: string | null }>(
      'SELECT state, attempt_count, lease_id FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(recovered.rows[0]).toEqual({ state: 'delivered', attempt_count: 2, lease_id: null });
    expect(fakeProviderReceipts).toHaveLength(1);
    const staleUpdate = await pool.query(
      `UPDATE email_verification_deliveries SET state = 'failed'
       WHERE verification_token_id = $1 AND state = 'leased' AND lease_id = $2 RETURNING id`,
      [tokenId, staleLeaseId],
    );
    expect(staleUpdate.rowCount).toBe(0);
    expect((await pool.query('SELECT state FROM email_verification_deliveries WHERE verification_token_id = $1', [tokenId])).rows[0].state)
      .toBe('delivered');
  });

  it('recovers after fake provider acceptance and OS process death before database acknowledgement', async () => {
    const email = `process-crash-after-${randomUUID()}@example.test`;
    const { tokenId } = await createPendingDelivery(email);
    expect(await runWorkerProcess('crash-after-provider-acceptance')).toBe(42);
    expect(fakeProviderReceipts).toHaveLength(1);
    const unacknowledged = await pool.query<{ state: string; attempt_count: number; lease_id: string }>(
      'SELECT state, attempt_count, lease_id FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(unacknowledged.rows[0].state).toBe('leased');
    expect(unacknowledged.rows[0].attempt_count).toBe(1);
    const staleLeaseId = unacknowledged.rows[0].lease_id;
    await pool.query(
      `UPDATE email_verification_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE verification_token_id = $1`,
      [tokenId],
    );

    expect(await runWorkerProcess('success')).toBe(0);
    const recovered = await pool.query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(recovered.rows[0]).toEqual({ state: 'delivered', attempt_count: 2 });
    expect(fakeProviderReceipts).toHaveLength(2);
    expect(fakeProviderReceipts.map(({ idempotencyKey }) => idempotencyKey))
      .toEqual([`email-verification/${tokenId}`, `email-verification/${tokenId}`]);
    const staleUpdate = await pool.query(
      `UPDATE email_verification_deliveries SET state = 'failed'
       WHERE verification_token_id = $1 AND state = 'leased' AND lease_id = $2 RETURNING id`,
      [tokenId, staleLeaseId],
    );
    expect(staleUpdate.rowCount).toBe(0);
  });

  it('records fake provider rejection, connection failure, and timeout with bounded state', async () => {
    const rejectedEmail = `process-reject-${randomUUID()}@example.test`;
    const rejected = await createPendingDelivery(rejectedEmail);
    expect(await runWorkerProcess('provider-rejection')).toBe(0);
    const rejectedState = await pool.query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM email_verification_deliveries WHERE verification_token_id = $1',
      [rejected.tokenId],
    );
    expect(rejectedState.rows[0]).toEqual({ state: 'failed', attempt_count: 1 });

    const connectionEmail = `process-connection-${randomUUID()}@example.test`;
    const connectionFailure = await createPendingDelivery(connectionEmail);
    expect(await runWorkerProcess('connection-failure')).toBe(0);
    const connectionState = await pool.query<{ state: string; attempt_count: number; last_failure_kind: string | null }>(
      'SELECT state, attempt_count, last_failure_kind FROM email_verification_deliveries WHERE verification_token_id = $1',
      [connectionFailure.tokenId],
    );
    expect(connectionState.rows[0]).toEqual({ state: 'pending', attempt_count: 1, last_failure_kind: 'network' });

    const timeoutEmail = `process-timeout-${randomUUID()}@example.test`;
    const timeout = await createPendingDelivery(timeoutEmail);
    expect(await runWorkerProcess('timeout')).toBe(0);
    const timeoutState = await pool.query<{ state: string; attempt_count: number; last_failure_kind: string | null }>(
      'SELECT state, attempt_count, last_failure_kind FROM email_verification_deliveries WHERE verification_token_id = $1',
      [timeout.tokenId],
    );
    expect(timeoutState.rows[0]).toEqual({ state: 'pending', attempt_count: 1, last_failure_kind: 'network' });
  }, 20_000);

  it('does not record delivery before provider acknowledgement and retries with the same idempotency identity', async () => {
    const email = `uncertain-${randomUUID()}@example.test`;
    const { tokenId } = await createPendingDelivery(email);
    await pool.query(
      `ALTER TABLE email_verification_deliveries
       ADD CONSTRAINT integration_reject_delivered CHECK (state <> 'delivered')`,
    );

    await runEmailVerificationDeliveryCycle();
    const unacknowledged = await pool.query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(unacknowledged.rows[0]).toEqual({ state: 'leased', attempt_count: 1 });
    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(1);

    await pool.query('ALTER TABLE email_verification_deliveries DROP CONSTRAINT integration_reject_delivered');
    await pool.query(
      `UPDATE email_verification_deliveries SET lease_expires_at = clock_timestamp() - interval '1 second'
       WHERE verification_token_id = $1`,
      [tokenId],
    );
    await runEmailVerificationDeliveryCycle();

    const acknowledged = await pool.query<{ state: string; attempt_count: number }>(
      'SELECT state, attempt_count FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(acknowledged.rows[0]).toEqual({ state: 'delivered', attempt_count: 2 });
    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(2);
    expect(fakeProvider.sendVerificationEmail.mock.calls[0][0].recordId).toBe(tokenId);
    expect(fakeProvider.sendVerificationEmail.mock.calls[1][0].recordId).toBe(tokenId);
  });

  it('cancels a pending delivery when its token was consumed before the worker runs', async () => {
    const email = `confirm-pending-${randomUUID()}@example.test`;
    const { tokenId, rawToken } = await createPendingDelivery(email);
    await confirmEmailVerification(rawToken);

    await runEmailVerificationDeliveryCycle();

    const { rows } = await pool.query<{ state: string }>(
      'SELECT state FROM email_verification_deliveries WHERE verification_token_id = $1',
      [tokenId],
    );
    expect(rows[0].state).toBe('cancelled');
    expect(fakeProvider.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('cancels an expired token and terminally fails after the configured retry cap', async () => {
    const expiredEmail = `expired-${randomUUID()}@example.test`;
    const expired = await createPendingDelivery(expiredEmail);
    await pool.query(
      `UPDATE email_verification_tokens
       SET created_at = clock_timestamp() - interval '2 hours',
           expires_at = clock_timestamp() - interval '1 second'
       WHERE id = $1`,
      [expired.tokenId],
    );
    await runEmailVerificationDeliveryCycle();
    const expiredState = await pool.query<{ state: string }>(
      'SELECT state FROM email_verification_deliveries WHERE verification_token_id = $1',
      [expired.tokenId],
    );
    expect(expiredState.rows[0].state).toBe('cancelled');
    expect(fakeProvider.sendVerificationEmail).not.toHaveBeenCalled();

    const retryEmail = `max-retry-${randomUUID()}@example.test`;
    const retry = await createPendingDelivery(retryEmail);
    fakeProvider.sendVerificationEmail.mockResolvedValue({ ok: false, reason: 'network', retryable: true });
    for (let attempt = 1; attempt <= 5; attempt++) {
      if (attempt > 1) {
        await pool.query(
          "UPDATE email_verification_deliveries SET available_at = clock_timestamp() - interval '1 second' WHERE verification_token_id = $1",
          [retry.tokenId],
        );
      }
      await runEmailVerificationDeliveryCycle();
    }
    const exhausted = await pool.query<{ state: string; attempt_count: number; ciphertext: Buffer | null }>(
      'SELECT state, attempt_count, ciphertext FROM email_verification_deliveries WHERE verification_token_id = $1',
      [retry.tokenId],
    );
    expect(exhausted.rows[0]).toEqual({ state: 'failed', attempt_count: 5, ciphertext: null });
    expect(fakeProvider.sendVerificationEmail).toHaveBeenCalledTimes(5);
    expect(fakeProvider.sendVerificationEmail.mock.calls.every(([message]) => message.recordId === retry.tokenId)).toBe(true);
  });

  it('cascades account deletion through pending verification tokens and deliveries', async () => {
    const email = `delete-${randomUUID()}@example.test`;
    const { tokenId } = await createPendingDelivery(email);
    const user = await pool.query<{ user_id: string }>(
      'SELECT user_id FROM email_verification_tokens WHERE id = $1',
      [tokenId],
    );
    await pool.query('DELETE FROM users WHERE id = $1', [user.rows[0].user_id]);
    const remaining = await pool.query<{ tokens: number; deliveries: number }>(
      `SELECT
         (SELECT count(*)::integer FROM email_verification_tokens WHERE id = $1) AS tokens,
         (SELECT count(*)::integer FROM email_verification_deliveries WHERE verification_token_id = $1) AS deliveries`,
      [tokenId],
    );
    expect(remaining.rows[0]).toEqual({ tokens: 0, deliveries: 0 });
    expect(fakeProvider.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('enforces IP, recipient, and token windows with concurrent middleware calls', async () => {
    const ipResults = await Promise.all(Array.from({ length: 12 }, (_, index) => runMiddleware(
      verificationRequestRateLimit,
      mockRequest('198.51.100.250', { email: `limit-${index}-${randomUUID()}@example.test` }),
    )));
    expect(ipResults.filter((error) => error === undefined)).toHaveLength(10);
    expect(ipResults.filter(Boolean)).toHaveLength(2);

    await pool.query('TRUNCATE email_verification_rate_limits');
    const recipientResults = await Promise.all(Array.from({ length: 5 }, (_, index) => {
      const request = mockRequest(`203.0.113.${index + 1}`, { email: 'shared-limit@example.test' });
      return runMiddleware(verificationRequestRateLimit, request).then((error) => ({ error, suppressed: request.emailVerificationSuppressed === true }));
    }));
    expect(recipientResults.every(({ error }) => error === undefined)).toBe(true);
    expect(recipientResults.filter(({ suppressed }) => suppressed)).toHaveLength(2);

    await pool.query('TRUNCATE email_verification_rate_limits');
    const tokenResults = await Promise.all(Array.from({ length: 12 }, (_, index) => runMiddleware(
      verificationConfirmationRateLimit,
      mockRequest(`192.0.2.${index + 1}`, { token: 'same-integration-token' }),
    )));
    expect(tokenResults.filter((error) => error === undefined)).toHaveLength(10);
    expect(tokenResults.filter(Boolean)).toHaveLength(2);

    await pool.query('TRUNCATE email_verification_rate_limits');
    const confirmationIpResults = await Promise.all(Array.from({ length: 32 }, (_, index) => runMiddleware(
      verificationConfirmationRateLimit,
      mockRequest('192.0.2.250', { token: `unique-confirmation-${index}` }),
    )));
    expect(confirmationIpResults.filter((error) => error === undefined)).toHaveLength(30);
    expect(confirmationIpResults.filter(Boolean)).toHaveLength(2);
  });

  it('retains the shared IP limit across a separate Node process', async () => {
    const ip = '198.51.100.251';
    const sameIp = await Promise.all(Array.from({ length: 10 }, (_, index) => runMiddleware(
      verificationRequestRateLimit,
      mockRequest(ip, { email: `restart-${index}-${randomUUID()}@example.test` }),
    )));
    expect(sameIp.every((error) => error === undefined)).toBe(true);
    const childScript = `const { pool } = require('./src/db/pool'); const { verificationRequestRateLimit } = require('./src/middleware/emailVerificationRateLimit'); const req = { ip: '${ip}', body: { email: 'restart-child@example.test' }, socket: { remoteAddress: '${ip}' } }; let error; verificationRequestRateLimit(req, {}, nextError => { error = nextError; }).then(async () => { console.log(error ? error.statusCode : 200); await pool.end(); }).catch(async () => { console.log('FAILED'); await pool.end(); process.exitCode = 1; });`;
    const result = execFileSync(process.execPath, ['-r', 'tsx/cjs', '-e', childScript], {
      cwd: process.cwd(),
      env: process.env,
      encoding: 'utf8',
    });
    expect(result.trim()).toBe('429');
  });

  it('rejects wrong keys and modified authenticated ciphertext', async () => {
    const encrypted = encryptEmailToken('one-time-token-material');
    expect(decryptEmailToken(encrypted)).toBe('one-time-token-material');
    const modifiedCiphertext = { ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext) };
    modifiedCiphertext.ciphertext[0] ^= 1;
    expect(() => decryptEmailToken(modifiedCiphertext)).toThrow();
    const modifiedTag = { ...encrypted, authTag: Buffer.from(encrypted.authTag) };
    modifiedTag.authTag[0] ^= 1;
    expect(() => decryptEmailToken(modifiedTag)).toThrow();

    const script = `const { decryptEmailToken } = require('./src/modules/auth/email-token-crypto'); try { decryptEmailToken({ ciphertext: Buffer.from(process.argv[1], 'base64'), nonce: Buffer.from(process.argv[2], 'base64'), authTag: Buffer.from(process.argv[3], 'base64') }); process.exit(2); } catch { console.log('rejected'); }`;
    const result = execFileSync(process.execPath, ['-r', 'tsx/cjs', '-e', script,
      encrypted.ciphertext.toString('base64'), encrypted.nonce.toString('base64'), encrypted.authTag.toString('base64')], {
      cwd: process.cwd(),
      env: { ...process.env, EMAIL_DELIVERY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64') },
      encoding: 'utf8',
    });
    expect(result.trim()).toBe('rejected');
  });
});
