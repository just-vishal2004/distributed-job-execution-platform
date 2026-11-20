import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { logger } from '../utils/logger';
import { isUnscopedQueueEnabled } from '../config/queue-safety';

const ACTIVE = "('assigned', 'running')";
let recoveryCursor: { leaseExpiresAt: Date | string; id: string } | null = null;

export type ExecutionJob = {
  id: string;
  executionId: string;
  name: string;
  payload: Record<string, unknown>;
  priority: number;
  attempt: number;
  leaseToken: string;
};

export async function assignNextJob(): Promise<boolean> {
  if (!isUnscopedQueueEnabled()) return false;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: jobs } = await client.query<{
      id: string; retry_count: number; name: string;
    }>(`SELECT id, retry_count, name FROM background_jobs
         WHERE status = 'pending' AND (scheduled_at IS NULL OR scheduled_at <= NOW())
         ORDER BY priority DESC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!jobs[0]) {
      await client.query('ROLLBACK');
      return false;
    }
    const { rows: workers } = await client.query<{ id: string; hostname: string }>(
      `SELECT id, hostname FROM workers WHERE status = 'idle' AND credential_hash IS NOT NULL
       ORDER BY last_heartbeat DESC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!workers[0]) {
      await client.query('ROLLBACK');
      return false;
    }
    const job = jobs[0];
    const worker = workers[0];
    const token = randomUUID();
    await client.query(
      `UPDATE background_jobs SET status = 'queued' WHERE id = $1 AND status = 'pending'`,
      [job.id],
    );
    await client.query(`UPDATE workers SET status = 'busy' WHERE id = $1 AND status = 'idle'`, [worker.id]);
    await client.query(
      `INSERT INTO job_executions (job_id, worker_id, attempt, status, lease_token, lease_expires_at)
       VALUES ($1, $2, $3, 'assigned', $4, clock_timestamp() + INTERVAL '1 second' * $5)`,
      [job.id, worker.id, job.retry_count + 1, token, Number(process.env.HEARTBEAT_TIMEOUT_SECONDS ?? 45)],
    );
    await client.query('COMMIT');
    logger.info('Background job assigned to worker', { backgroundJobId: job.id, workerId: worker.id, attempt: job.retry_count + 1 });
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Scheduler assignment failed', { error: err instanceof Error ? err.message : String(err) });
    return false;
  } finally {
    client.release();
  }
}

export async function pollAssignedJob(workerId: string): Promise<ExecutionJob | null> {
  if (!isUnscopedQueueEnabled()) return null;

  const { rows } = await pool.query<{
    id: string; execution_id: string; name: string; payload: Record<string, unknown>; priority: number;
    attempt: number; lease_token: string;
  }>(`SELECT j.id, j.name, j.payload, j.priority, je.attempt, je.lease_token,
             je.id AS execution_id
      FROM job_executions je JOIN background_jobs j ON j.id = je.job_id
      WHERE je.worker_id = $1 AND je.status = 'assigned' AND j.status = 'queued'
        AND je.lease_expires_at > clock_timestamp()
      ORDER BY je.started_at ASC LIMIT 1`, [workerId]);
  const row = rows[0];
  return row ? { id: row.id, executionId: row.execution_id, name: row.name, payload: row.payload, priority: row.priority, attempt: row.attempt, leaseToken: row.lease_token } : null;
}

async function withActiveAttempt<T>(
  jobId: string, workerId: string, token: string,
  operation: (client: PoolClient, executionId: string, retryCount: number, maxRetries: number) => Promise<T>,
): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: jobs } = await client.query<{ retry_count: number; max_retries: number; status: string }>(
      `SELECT retry_count, max_retries, status FROM background_jobs WHERE id = $1 FOR UPDATE`, [jobId]);
    const job = jobs[0];
    if (!job || !['queued', 'running'].includes(job.status)) {
      await client.query('ROLLBACK');
      return null;
    }
    const { rows: executions } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM job_executions
       WHERE job_id = $1 AND worker_id = $2 AND lease_token = $3
         AND status IN ${ACTIVE} FOR UPDATE`,
      [jobId, workerId, token]);
    const execution = executions[0];
    if (!execution) {
      await client.query('ROLLBACK');
      return null;
    }
    const { rows: leases } = await client.query<{ valid: boolean }>(
      `SELECT lease_expires_at > clock_timestamp() AS valid
       FROM job_executions WHERE id = $1`, [execution.id],
    );
    if (!leases[0]?.valid) {
      await client.query('ROLLBACK');
      return null;
    }
    const result = await operation(client, execution.id, job.retry_count, job.max_retries);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function startExecution(jobId: string, workerId: string, token: string): Promise<boolean> {
  return (await withActiveAttempt(jobId, workerId, token, async (client, executionId) => {
    await client.query(`UPDATE job_executions SET status = 'running' WHERE id = $1 AND status = 'assigned'`, [executionId]);
    await client.query(`UPDATE background_jobs SET status = 'running' WHERE id = $1 AND status = 'queued'`, [jobId]);
    return true;
  })) ?? false;
}

export async function updateExecutionProgress(jobId: string, workerId: string, token: string, percent: number): Promise<boolean> {
  return (await withActiveAttempt(jobId, workerId, token, async (client, executionId) => {
    await client.query(`UPDATE job_executions SET status = 'running', lease_expires_at = clock_timestamp() + INTERVAL '1 second' * $2 WHERE id = $1`, [executionId, Number(process.env.HEARTBEAT_TIMEOUT_SECONDS ?? 45)]);
    await client.query(`UPDATE background_jobs SET status = 'running' WHERE id = $1 AND status = 'queued'`, [jobId]);
    await client.query(
      `INSERT INTO execution_logs (job_id, worker_id, execution_id, level, message)
       VALUES ($1, $2, $3, 'info', $4)`,
      [jobId, workerId, executionId, `Progress: ${percent}%`],
    );
    return true;
  })) ?? false;
}

export async function completeExecution(jobId: string, workerId: string, token: string): Promise<boolean> {
  const result = await withActiveAttempt(jobId, workerId, token, async (client, executionId) => {
    await client.query(`UPDATE job_executions SET status = 'completed', finished_at = NOW() WHERE id = $1`, [executionId]);
    await client.query(`UPDATE background_jobs SET status = 'completed' WHERE id = $1`, [jobId]);
    await client.query(`UPDATE workers SET status = 'idle' WHERE id = $1 AND status = 'busy'`, [workerId]);
    return true;
  });
  if (result) logger.info('Background job completed', { jobId, workerId });
  if (result) return true;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM job_executions WHERE job_id = $1 AND worker_id = $2
     AND lease_token = $3 AND status = 'completed'`, [jobId, workerId, token]);
  return rows.length > 0;
}

async function closeAttempt(jobId: string, workerId: string, token: string, status: 'failed' | 'timed_out', errorMessage: string): Promise<boolean> {
  return (await withActiveAttempt(jobId, workerId, token, async (client, executionId, retryCount, maxRetries) => {
    await client.query(`UPDATE job_executions SET status = $2, finished_at = NOW(), error_message = $3 WHERE id = $1`, [executionId, status, errorMessage]);
    if (retryCount < maxRetries) {
      const delay = Math.round(Math.min(5 * Math.pow(2, retryCount), 300) + Math.random() * 10);
      await client.query(`UPDATE background_jobs SET status = 'pending', retry_count = retry_count + 1, scheduled_at = clock_timestamp() + INTERVAL '1 second' * $2 WHERE id = $1`, [jobId, delay]);
    } else {
      await client.query(`UPDATE background_jobs SET status = 'failed' WHERE id = $1`, [jobId]);
    }
    await client.query(`UPDATE workers SET status = 'idle' WHERE id = $1 AND status = 'busy'`, [workerId]);
    return true;
  })) ?? false;
}

export async function failExecution(jobId: string, workerId: string, token: string, errorMessage: string): Promise<boolean> {
  const result = await closeAttempt(jobId, workerId, token, 'failed', errorMessage);
  if (result) return true;
  const { rows } = await pool.query<{ id: string }>(
    `SELECT id FROM job_executions WHERE job_id = $1 AND worker_id = $2
     AND lease_token = $3 AND status = 'failed'`, [jobId, workerId, token]);
  return rows.length > 0;
}

export async function recoverExpiredExecutions(timeoutSeconds: number, batchSize = 100): Promise<number> {
  const limit = Number.isFinite(batchSize) ? Math.min(500, Math.max(1, Math.floor(batchSize))) : 100;
  const selectCandidates = async (cursor: typeof recoveryCursor) => {
    if (cursor) {
      return pool.query<{
        id: string; job_id: string; worker_id: string; lease_expires_at: Date | string;
      }>(
        `SELECT id, job_id, worker_id, lease_expires_at FROM job_executions
         WHERE status IN ${ACTIVE} AND lease_expires_at <= clock_timestamp()
           AND (lease_expires_at, id) > ($1::timestamptz, $2::uuid)
         ORDER BY lease_expires_at, id LIMIT $3`,
        [cursor.leaseExpiresAt, cursor.id, limit],
      );
    }
    return pool.query<{
      id: string; job_id: string; worker_id: string; lease_expires_at: Date | string;
    }>(
      `SELECT id, job_id, worker_id, lease_expires_at FROM job_executions
       WHERE status IN ${ACTIVE} AND lease_expires_at <= clock_timestamp()
       ORDER BY lease_expires_at, id LIMIT $1`, [limit],
    );
  };
  let { rows: candidates } = await selectCandidates(recoveryCursor);
  if (recoveryCursor && candidates.length === 0) {
    recoveryCursor = null;
    ({ rows: candidates } = await selectCandidates(null));
  }
  let recovered = 0;
  for (const candidate of candidates) {
    try {
      if (await recoverExpiredExecution(candidate, timeoutSeconds)) recovered++;
    } catch (err) {
      logger.error('Expired execution recovery failed', {
        executionId: candidate.id,
        error: err instanceof Error ? err.message : 'recovery failed',
      });
    }
  }
  const lastCandidate = candidates.at(-1);
  if (lastCandidate?.lease_expires_at) {
    recoveryCursor = { leaseExpiresAt: lastCandidate.lease_expires_at, id: lastCandidate.id };
  }
  return recovered;
}

async function recoverExpiredExecution(
  candidate: { id: string; job_id: string; worker_id: string },
  timeoutSeconds: number,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
      const { rows: jobs } = await client.query<{ retry_count: number; max_retries: number; status: string }>(
        `SELECT retry_count, max_retries, status FROM background_jobs WHERE id = $1 FOR UPDATE`, [candidate.job_id]);
      const job = jobs[0];
      if (!job) {
        await client.query('ROLLBACK');
        return false;
      }
      const { rows: activeRows } = await client.query<{ id: string }>(
        `SELECT id FROM job_executions WHERE id = $1 AND status IN ${ACTIVE}
         FOR UPDATE`, [candidate.id]);
      if (!activeRows[0]) {
        await client.query('ROLLBACK');
        return false;
      }
      const { rows: leaseRows } = await client.query<{ expired: boolean }>(
        `SELECT lease_expires_at <= clock_timestamp() AS expired
         FROM job_executions WHERE id = $1`, [candidate.id]);
      if (!leaseRows[0]?.expired) {
        await client.query('ROLLBACK');
        return false;
      }
      const cancelled = job.status === 'cancelled';
      await client.query(
        `UPDATE job_executions SET status = $2, finished_at = NOW(), error_message = $3 WHERE id = $1`,
        [candidate.id, cancelled ? 'cancelled' : 'timed_out', cancelled ? 'Job cancelled' : 'Execution lease expired'],
      );
      if (!cancelled && job.retry_count < job.max_retries && ['queued', 'running'].includes(job.status)) {
        const delay = Math.round(Math.min(5 * Math.pow(2, job.retry_count), 300) + Math.random() * 10);
        await client.query(`UPDATE background_jobs SET status = 'pending', retry_count = retry_count + 1, scheduled_at = clock_timestamp() + INTERVAL '1 second' * $2 WHERE id = $1`, [candidate.job_id, delay]);
      } else if (['queued', 'running'].includes(job.status)) {
        await client.query(`UPDATE background_jobs SET status = 'failed' WHERE id = $1`, [candidate.job_id]);
      }
      await client.query(`UPDATE workers
        SET status = CASE
          WHEN last_heartbeat < clock_timestamp() - INTERVAL '1 second' * $2 THEN 'dead'::worker_status
          ELSE 'revoking'::worker_status
        END
        WHERE id = $1 AND status != 'dead'`, [candidate.worker_id, timeoutSeconds]);
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
