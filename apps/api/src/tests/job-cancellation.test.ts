import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/pool';
import { cancelBackgroundJob } from '../services/background-job.service';
import { recoverExpiredExecutions } from '../services/execution.service';
import { completeExecution } from '../services/execution.service';
import { deregisterWorker } from '../services/worker.service';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

const jobRow = (status: string) => ({
  id: 'job-1', name: 'task', payload: {}, status, priority: 5,
  max_retries: 2, retry_count: 0, scheduled_at: null,
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
});

function cancellationClient(status: string, active = false) {
  const queries: string[] = [];
  const attempt = { id: 'attempt-1', worker_id: 'worker-1' };
  const query = vi.fn(async (sql: string) => {
    queries.push(sql);
    if (sql.includes('SELECT id, status FROM background_jobs')) return { rows: [{ id: 'job-1', status }] };
    if (sql.includes('SELECT id, worker_id FROM job_executions')) return { rows: active ? [attempt] : [] };
    if (sql.includes('UPDATE background_jobs SET status =')) return { rows: [jobRow('cancelled')] };
    return { rows: [] };
  });
  const client = { query, release: vi.fn() };
  vi.mocked(pool.connect).mockResolvedValue(client as never);
  return { client, queries };
}

describe('job cancellation consistency', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancels a pending job transactionally', async () => {
    const { client, queries } = cancellationClient('pending');
    const result = await cancelBackgroundJob('job-1');
    expect(result?.status).toBe('cancelled');
    expect(queries[0]).toBe('BEGIN');
    expect(queries.at(-1)).toBe('COMMIT');
    expect(queries.some((sql) => sql.includes('UPDATE job_executions'))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each(['queued', 'running'])('cancels a %s job and closes its active attempt', async (status) => {
    const { queries } = cancellationClient(status, true);
    expect((await cancelBackgroundJob('job-1'))?.status).toBe('cancelled');
    expect(queries.some((sql) => sql.includes("SET status = 'cancelled', finished_at"))).toBe(true);
    expect(queries.some((sql) => sql.includes("UPDATE workers SET status = 'revoking'"))).toBe(true);
    expect(queries.some((sql) => sql.includes("SET status = 'idle'"))).toBe(false);
    expect(queries.at(-1)).toBe('COMMIT');
  });

  it('repeats cancellation safely and resolves a legacy active attempt', async () => {
    const { queries } = cancellationClient('cancelled', true);
    expect((await cancelBackgroundJob('job-1'))?.status).toBe('cancelled');
    expect(queries.some((sql) => sql.includes("SET status = 'cancelled', finished_at"))).toBe(true);
  });

  it('does not overwrite a completed job when completion won the row-lock order', async () => {
    cancellationClient('completed');
    expect(await cancelBackgroundJob('job-1')).toBeNull();
  });

  it('rejects a completion callback after cancellation won the row-lock order', async () => {
    cancellationClient('queued', true);
    expect((await cancelBackgroundJob('job-1'))?.status).toBe('cancelled');
    const completionClient = { query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT retry_count')) return { rows: [{ retry_count: 0, max_retries: 2, status: 'cancelled' }] };
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(completionClient as never);
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    expect(await completeExecution('job-1', 'worker-1', 'old-lease')).toBe(false);
  });

  it('does not retry a cancelled job during expired-attempt recovery', async () => {
    const queries: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT retry_count, max_retries, status')) return { rows: [{ retry_count: 0, max_retries: 3, status: 'cancelled' }] };
      if (sql.includes('SELECT id FROM job_executions')) return { rows: [{ id: 'attempt-1' }] };
      if (sql.includes('SELECT lease_expires_at <= clock_timestamp')) return { rows: [{ expired: true }] };
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: 'attempt-1', job_id: 'job-1', worker_id: 'worker-1' }] } as never);
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect(await recoverExpiredExecutions(45)).toBe(1);
    expect(queries.some((sql) => sql.includes("SET status = 'pending'"))).toBe(false);
    expect(queries.some((sql) => sql.includes("SET status = 'failed'"))).toBe(false);
    expect(queries.some((sql) => sql.includes("SET status = $2, finished_at"))).toBe(true);
  });

  it('does not retry a cancelled job during graceful worker deregistration', async () => {
    const queries: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes('SELECT je.id, je.job_id')) return { rows: [{
        id: 'attempt-1', job_id: 'job-1', retry_count: 0, max_retries: 3,
        execution_status: 'running', job_status: 'cancelled',
      }] };
      if (sql.includes('SELECT status, retry_count, max_retries FROM background_jobs')) return { rows: [{ status: 'cancelled', retry_count: 0, max_retries: 3 }] };
      if (sql.includes('SELECT id, status FROM job_executions')) return { rows: [{ id: 'attempt-1', status: 'running' }] };
      if (sql.includes('UPDATE workers') && sql.includes('RETURNING')) {
        return { rows: [{ id: 'worker-1', hostname: 'worker', status: 'dead' }] };
      }
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect(await deregisterWorker('worker-1')).not.toBeNull();
    expect(queries.some((sql) => sql.includes("SET status = 'pending'"))).toBe(false);
    expect(queries.some((sql) => sql.includes("SET status = 'failed'"))).toBe(false);
    expect(queries.some((sql) => sql.includes("SET status = $2, finished_at"))).toBe(true);
  });
});
