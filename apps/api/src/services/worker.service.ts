import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { pool } from '../db/pool';
import { logger } from '../utils/logger';
import type {
  RegisterWorkerRequest,
  WorkerLeaseHeartbeatRequest,
  WorkerRevocationAcknowledgementRequest,
} from '@meridian/types';

function mapWorker(row: Record<string, unknown>) {
  return {
    id: row.id as string,
    hostname: row.hostname as string,
    status: row.status as string,
    lastHeartbeat: row.last_heartbeat as string,
    registeredAt: row.registered_at as string,
    metadata: row.metadata as Record<string, unknown>,
  };
}

export async function registerWorker(input: RegisterWorkerRequest) {
  const { hostname, metadata = {} } = input;
  const credential = randomBytes(32).toString('hex');
  const credentialHash = createHash('sha256').update(credential).digest('hex');

  const { rows } = await pool.query(
    `INSERT INTO workers (hostname, metadata, credential_hash)
     VALUES ($1, $2, $3)
     RETURNING id, hostname, status, last_heartbeat, registered_at, metadata`,
    [hostname, metadata, credentialHash],
  );

  logger.info('Worker registered', { workerId: rows[0].id, hostname });
  return { worker: mapWorker(rows[0]), credential };
}

export async function authenticateWorker(workerId: string, credential: string): Promise<boolean> {
  const { rows } = await pool.query<{ credential_hash: string | null; status: string }>(
    `SELECT credential_hash, status FROM workers WHERE id = $1`, [workerId]);
  const row = rows[0];
  if (!row || row.status === 'dead' || !row.credential_hash) return false;
  const candidate = createHash('sha256').update(credential).digest('hex');
  const expected = Buffer.from(row.credential_hash, 'hex');
  const actual = Buffer.from(candidate, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export type WorkerHeartbeatResult =
  | { worker: ReturnType<typeof mapWorker>; leaseValid: true; state: 'idle' | 'active' }
  | { worker: null; leaseValid: false; state: 'attempt_required' | 'revoked' };

export async function heartbeat(workerId: string, attempt?: WorkerLeaseHeartbeatRequest): Promise<WorkerHeartbeatResult | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (!attempt) {
      const { rows: active } = await client.query<{ id: string }>(
        `SELECT id FROM job_executions WHERE worker_id = $1
         AND status IN ('assigned', 'running') LIMIT 1`, [workerId],
      );
      if (active.length > 0) {
        await client.query('ROLLBACK');
        return { worker: null, leaseValid: false, state: 'attempt_required' };
      }
      const { rows: idleWorkers } = await client.query(
        `UPDATE workers SET last_heartbeat = clock_timestamp()
         WHERE id = $1 AND status = 'idle' RETURNING *`, [workerId],
      );
      if (!idleWorkers[0]) {
        const { rows: existing } = await client.query<{ status: string; has_active_attempt: boolean }>(
          `SELECT w.status, EXISTS (
             SELECT 1 FROM job_executions je WHERE je.worker_id = w.id
               AND je.status IN ('assigned', 'running')
           ) AS has_active_attempt
           FROM workers w WHERE w.id = $1`, [workerId],
        );
        await client.query('ROLLBACK');
        if (existing[0]?.status === 'dead' || !existing[0]) return null;
        if (existing[0].status === 'busy' && existing[0].has_active_attempt) {
          return { worker: null, leaseValid: false, state: 'attempt_required' };
        }
        return { worker: null, leaseValid: false, state: 'revoked' };
      }
      await client.query('COMMIT');
      return { worker: mapWorker(idleWorkers[0]), leaseValid: true, state: 'idle' };
    }

    const { rows: owned } = await client.query<{ job_id: string }>(
      `SELECT job_id FROM job_executions
       WHERE id = $1 AND job_id = $2 AND worker_id = $3 AND lease_token = $4`,
      [attempt.executionId, attempt.jobId, workerId, attempt.leaseToken],
    );
    if (!owned[0]) {
      await client.query('ROLLBACK');
      return { worker: null, leaseValid: false, state: 'revoked' };
    }
    const { rows: jobs } = await client.query<{ status: string }>(
      `SELECT status FROM background_jobs WHERE id = $1 FOR UPDATE`, [attempt.jobId],
    );
    const { rows: executions } = await client.query<{ id: string }>(
      `SELECT id FROM job_executions WHERE id = $1 AND job_id = $2 AND worker_id = $3
       AND lease_token = $4 AND status IN ('assigned', 'running') FOR UPDATE`,
      [attempt.executionId, attempt.jobId, workerId, attempt.leaseToken],
    );
    if (!jobs[0] || !['queued', 'running'].includes(jobs[0].status) || !executions[0]) {
      await client.query('ROLLBACK');
      return { worker: null, leaseValid: false, state: 'revoked' };
    }
    const { rows: renewed } = await client.query<{ id: string }>(
      `UPDATE job_executions
       SET lease_expires_at = clock_timestamp() + INTERVAL '1 second' * $2
       WHERE id = $1 AND status IN ('assigned', 'running')
         AND lease_expires_at > clock_timestamp()
       RETURNING id`,
      [attempt.executionId, Number(process.env.HEARTBEAT_TIMEOUT_SECONDS ?? 45)],
    );
    if (!renewed[0]) {
      await client.query('ROLLBACK');
      return { worker: null, leaseValid: false, state: 'revoked' };
    }
    const { rows: workers } = await client.query(
      `UPDATE workers SET last_heartbeat = clock_timestamp()
       WHERE id = $1 AND status = 'busy' RETURNING *`, [workerId],
    );
    if (!workers[0]) {
      await client.query('ROLLBACK');
      return { worker: null, leaseValid: false, state: 'revoked' };
    }
    await client.query('COMMIT');
    return { worker: mapWorker(workers[0]), leaseValid: true, state: 'active' };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function acknowledgeRevocation(
  workerId: string,
  attempt: WorkerRevocationAcknowledgementRequest,
): Promise<{ acknowledged: true; released: boolean } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: jobs } = await client.query<{ id: string }>(
      `SELECT id FROM background_jobs WHERE id = $1 FOR UPDATE`, [attempt.jobId],
    );
    if (!jobs[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const { rows: executions } = await client.query<{
      id: string; status: string; revocation_acknowledged_at: Date | string | null;
    }>(
      `SELECT id, status, revocation_acknowledged_at FROM job_executions
       WHERE id = $1 AND job_id = $2 AND worker_id = $3 AND lease_token = $4
         AND status IN ('cancelled', 'timed_out') FOR UPDATE`,
      [attempt.executionId, attempt.jobId, workerId, attempt.leaseToken],
    );
    if (!executions[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const execution = executions[0];
    if (!['cancelled', 'timed_out'].includes(execution.status)) {
      await client.query('ROLLBACK');
      return null;
    }
    const { rows: workers } = await client.query<{ status: string }>(
      `SELECT status FROM workers WHERE id = $1 FOR UPDATE`, [workerId],
    );
    if (!workers[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const alreadyAcknowledged = execution.revocation_acknowledged_at !== null;
    if (workers[0].status !== 'revoking') {
      if (alreadyAcknowledged) {
        await client.query('COMMIT');
        return { acknowledged: true, released: workers[0].status === 'idle' };
      }
      await client.query('ROLLBACK');
      return null;
    }
    if (!alreadyAcknowledged) {
      await client.query(
        `UPDATE job_executions SET revocation_acknowledged_at = clock_timestamp()
         WHERE id = $1 AND job_id = $2 AND worker_id = $3 AND lease_token = $4
           AND status IN ('cancelled', 'timed_out') AND revocation_acknowledged_at IS NULL`,
        [attempt.executionId, attempt.jobId, workerId, attempt.leaseToken],
      );
    }
    const { rows: releasedWorkers } = await client.query(
      `UPDATE workers w SET status = 'idle', last_heartbeat = clock_timestamp()
       WHERE w.id = $1 AND w.status = 'revoking'
         AND NOT EXISTS (
           SELECT 1 FROM job_executions active
           WHERE active.worker_id = w.id AND active.status IN ('assigned', 'running')
         )
         AND NOT EXISTS (
           SELECT 1 FROM job_executions pending
           WHERE pending.worker_id = w.id
             AND pending.status IN ('cancelled', 'timed_out')
             AND pending.revocation_acknowledged_at IS NULL
         )
       RETURNING w.id`, [workerId],
    );
    const released = releasedWorkers.length > 0;
    await client.query('COMMIT');
    return { acknowledged: true, released };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function deregisterWorker(workerId: string) {
  // Graceful shutdown: mark as dead and return any in-flight background jobs to pending
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const { rows: candidates } = await client.query<{ id: string; job_id: string }>(
      `SELECT je.id, je.job_id FROM job_executions je
        WHERE je.worker_id = $1 AND je.status IN ('assigned', 'running')
        ORDER BY je.job_id, je.id`, [workerId]);
    const attempts: Array<{
      id: string; job_id: string; retry_count: number; max_retries: number;
      job_status: string; execution_status: string;
    }> = [];
    for (const candidate of candidates) {
      const { rows: jobs } = await client.query<{ status: string; retry_count: number; max_retries: number }>(
        `SELECT status, retry_count, max_retries FROM background_jobs WHERE id = $1 FOR UPDATE`, [candidate.job_id],
      );
      if (!jobs[0]) continue;
      const { rows: lockedAttempts } = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM job_executions WHERE id = $1 AND worker_id = $2
         AND status IN ('assigned', 'running') FOR UPDATE`, [candidate.id, workerId],
      );
      if (!lockedAttempts[0]) continue;
      attempts.push({
        id: candidate.id,
        job_id: candidate.job_id,
        execution_status: lockedAttempts[0].status,
        job_status: jobs[0].status,
        retry_count: jobs[0].retry_count,
        max_retries: jobs[0].max_retries,
      });
    }

    // Mark worker as dead
    const { rows } = await client.query(
      `UPDATE workers
       SET status = 'dead'
       WHERE id = $1
         AND status != 'dead'
       RETURNING *`,
      [workerId],
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    for (const attempt of attempts) {
      const cancelled = attempt.job_status === 'cancelled';
      await client.query(
        `UPDATE job_executions SET status = $2, finished_at = NOW(),
         error_message = $3 WHERE id = $1`,
        [attempt.id, cancelled ? 'cancelled' : 'timed_out', cancelled ? 'Job cancelled' : 'Worker deregistered gracefully'],
      );
      if (cancelled) {
        continue;
      }
      if (attempt.retry_count < attempt.max_retries && ['queued', 'running'].includes(attempt.job_status)) {
        const delay = Math.round(Math.min(5 * Math.pow(2, attempt.retry_count), 300) + Math.random() * 10);
        await client.query(
          `UPDATE background_jobs SET status = 'pending', retry_count = retry_count + 1,
           scheduled_at = clock_timestamp() + INTERVAL '1 second' * $2 WHERE id = $1`, [attempt.job_id, delay]);
      } else if (['queued', 'running'].includes(attempt.job_status)) {
        await client.query(`UPDATE background_jobs SET status = 'failed' WHERE id = $1`, [attempt.job_id]);
      }
    }

    await client.query('COMMIT');

    logger.info('Worker deregistered', { workerId });
    return mapWorker(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function getWorkers() {
  const { rows } = await pool.query(
    `SELECT id, hostname, status, last_heartbeat, registered_at, metadata
     FROM workers ORDER BY registered_at DESC`,
  );
  return rows.map(mapWorker);
}

export async function getWorkerById(workerId: string) {
  const { rows } = await pool.query(
    `SELECT id, hostname, status, last_heartbeat, registered_at, metadata
     FROM workers WHERE id = $1`,
    [workerId],
  );
  if (rows.length === 0) return null;
  return mapWorker(rows[0]);
}
