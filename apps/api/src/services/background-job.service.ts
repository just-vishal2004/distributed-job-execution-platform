import { pool } from '../db/pool';
import { logger } from '../utils/logger';
import type {
  BackgroundJob,
  JobExecution,
  ExecutionLog,
  SubmitBackgroundJobRequest,
} from '@meridian/types';

function mapBackgroundJob(row: Record<string, unknown>): BackgroundJob {
  return {
    id: row.id as string,
    name: row.name as string,
    payload: row.payload as Record<string, unknown>,
    status: row.status as BackgroundJob['status'],
    priority: row.priority as number,
    maxRetries: row.max_retries as number,
    retryCount: row.retry_count as number,
    scheduledAt: (row.scheduled_at as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export async function createBackgroundJob(
  input: SubmitBackgroundJobRequest,
): Promise<BackgroundJob> {
  const { name, payload, priority = 5, maxRetries = 3, scheduledAt = null } =
    input;

  const { rows } = await pool.query(
    `INSERT INTO background_jobs (name, payload, priority, max_retries, scheduled_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [name, payload, priority, maxRetries, scheduledAt],
  );

  logger.info('Background job created', {
    backgroundJobId: rows[0].id,
    name,
    priority,
  });
  return mapBackgroundJob(rows[0]);
}

export async function getBackgroundJobs(filters: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<BackgroundJob[]> {
  const { status, limit = 20, offset = 0 } = filters;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }

  const whereClause =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  params.push(limit);
  params.push(offset);

  const { rows } = await pool.query(
    `SELECT id, name, payload, status, priority, max_retries, retry_count,
            scheduled_at, created_at, updated_at
     FROM background_jobs
     ${whereClause}
     ORDER BY priority DESC, created_at ASC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  return rows.map(mapBackgroundJob);
}

export async function getBackgroundJobById(
  id: string,
): Promise<BackgroundJob | null> {
  const { rows } = await pool.query(
    `SELECT id, name, payload, status, priority, max_retries, retry_count,
            scheduled_at, created_at, updated_at
     FROM background_jobs WHERE id = $1`,
    [id],
  );

  if (rows.length === 0) return null;
  return mapBackgroundJob(rows[0]);
}

export async function getBackgroundJobWithExecutions(id: string): Promise<{
  backgroundJob: BackgroundJob;
  executions: JobExecution[];
  logs: ExecutionLog[];
} | null> {
  const backgroundJob = await getBackgroundJobById(id);
  if (!backgroundJob) return null;

  const { rows: executions } = await pool.query<JobExecution>(
    `SELECT je.id, je.job_id, je.worker_id, je.attempt, je.status,
            je.started_at, je.finished_at, je.error_message,
            w.hostname AS worker_hostname
     FROM job_executions je
     LEFT JOIN workers w ON w.id = je.worker_id
     WHERE je.job_id = $1
     ORDER BY je.attempt ASC`,
    [id],
  );

  const { rows: logs } = await pool.query<ExecutionLog>(
    `SELECT id, job_id, worker_id, execution_id AS "executionId", level, message, created_at
     FROM execution_logs WHERE job_id = $1 ORDER BY created_at ASC`,
    [id],
  );

  return { backgroundJob, executions, logs };
}

export async function cancelBackgroundJob(
  id: string,
): Promise<BackgroundJob | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: jobs } = await client.query(
      `SELECT id, status FROM background_jobs WHERE id = $1 FOR UPDATE`, [id],
    );
    const job = jobs[0];
    if (!job) {
      await client.query('ROLLBACK');
      return null;
    }
    if (!['pending', 'queued', 'running', 'cancelled'].includes(job.status)) {
      await client.query('ROLLBACK');
      return null;
    }

    const { rows: attempts } = await client.query<{ id: string; worker_id: string }>(
      `SELECT id, worker_id FROM job_executions
       WHERE job_id = $1 AND status IN ('assigned', 'running')
       ORDER BY worker_id FOR UPDATE`, [id],
    );
    for (const attempt of attempts) {
      await client.query(
        `UPDATE job_executions
         SET status = 'cancelled', finished_at = NOW(), error_message = 'Job cancelled'
         WHERE id = $1 AND status IN ('assigned', 'running')`, [attempt.id],
      );
      await client.query(
        `UPDATE workers SET status = 'revoking'
         WHERE id = $1 AND status != 'dead'`, [attempt.worker_id],
      );
    }
    const { rows } = await client.query(
      `UPDATE background_jobs SET status = 'cancelled'
       WHERE id = $1 AND status IN ('pending', 'queued', 'running', 'cancelled')
       RETURNING id, name, payload, status, priority, max_retries, retry_count,
                 scheduled_at, created_at, updated_at`, [id],
    );
    if (!rows[0]) throw new Error('Locked job changed during cancellation');
    await client.query('COMMIT');
    logger.info('Background job cancelled', { backgroundJobId: id });
    return mapBackgroundJob(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
