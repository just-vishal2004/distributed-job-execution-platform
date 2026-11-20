import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { pool } from '../db/pool';
import * as Execution from '../services/execution.service';
import * as Workers from '../services/worker.service';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

const active = { id: 'attempt-1', status: 'assigned' };
const job = { retry_count: 0, max_retries: 2, status: 'queued' };

function clientWith(queryImpl: (sql: string, params?: unknown[]) => unknown) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => queryImpl(sql, params));
  const client = { query, release: vi.fn() };
  vi.mocked(pool.connect).mockResolvedValue(client as never);
  return client;
}

describe('execution lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('UNSCOPED_QUEUE_ENABLED', 'true');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('refuses unscoped assignment when the safety switch is absent or disabled', async () => {
    vi.stubEnv('UNSCOPED_QUEUE_ENABLED', 'false');
    expect(await Execution.assignNextJob()).toBe(false);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('serializes competing workers so a single queued task is assigned once', async () => {
    let claimed = false;
    const c = clientWith((sql) => {
      if (sql.includes('SELECT id, retry_count, name')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: 'job-1', retry_count: 0, name: 'one' }] };
      }
      if (sql.includes('SELECT id, hostname')) return { rows: [{ id: 'worker-1', hostname: 'w' }] };
      return { rows: [] };
    });
    const outcomes = await Promise.all([Execution.assignNextJob(), Execution.assignNextJob()]);
    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect(c.query).toHaveBeenCalledWith('COMMIT');
    expect(c.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('assigns multiple queued tasks to multiple idle workers in separate transactions', async () => {
    let jobs = 2;
    let workers = 2;
    const c = clientWith((sql) => {
      if (sql.includes('SELECT id, retry_count, name')) return jobs-- > 0 ? { rows: [{ id: `j${jobs}`, retry_count: 0, name: 'x' }] } : { rows: [] };
      if (sql.includes('SELECT id, hostname')) return workers-- > 0 ? { rows: [{ id: `w${workers}`, hostname: 'w' }] } : { rows: [] };
      return { rows: [] };
    });
    expect(await Execution.assignNextJob()).toBe(true);
    expect(await Execution.assignNextJob()).toBe(true);
    expect(c.query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO job_executions'))).toHaveLength(2);
  });

  it('rolls back job and worker reservation when attempt insertion fails', async () => {
    const c = clientWith((sql) => {
      if (sql.includes('SELECT id, retry_count, name')) return { rows: [{ id: 'j', retry_count: 0, name: 'x' }] };
      if (sql.includes('SELECT id, hostname')) return { rows: [{ id: 'w', hostname: 'w' }] };
      if (sql.includes('INSERT INTO job_executions')) throw new Error('insert failed');
      return { rows: [] };
    });
    expect(await Execution.assignNextJob()).toBe(false);
    expect(c.query).toHaveBeenCalledWith('ROLLBACK');
    expect(c.query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('rejects a worker that does not own the active execution', async () => {
    clientWith((sql) => sql.includes('SELECT retry_count') ? { rows: [job] } : { rows: [] });
    expect(await Execution.startExecution('j', 'wrong-worker', 'token')).toBe(false);
  });

  it('stores only the worker credential hash and authenticates the bearer value', async () => {
    const query = vi.mocked(pool.query);
    query.mockResolvedValueOnce({ rows: [{ id: 'worker-1', hostname: 'host', status: 'idle', last_heartbeat: new Date(), registered_at: new Date(), metadata: {} }] } as never);
    const registered = await Workers.registerWorker({ hostname: 'host' });
    expect(registered.credential).toMatch(/^[a-f0-9]{64}$/);
    const insert = query.mock.calls[0];
    expect(insert[0]).toContain('credential_hash');
    expect(insert[1]?.[2]).toBe(createHash('sha256').update(registered.credential).digest('hex'));
    expect(insert[1]?.[2]).not.toBe(registered.credential);

    query.mockResolvedValueOnce({ rows: [{ credential_hash: createHash('sha256').update(registered.credential).digest('hex'), status: 'idle' }] } as never);
    expect(await Workers.authenticateWorker('worker-1', registered.credential)).toBe(true);
  });

  it('accepts a duplicate completion without applying terminal updates twice', async () => {
    let completed = false;
    const c = clientWith((sql) => {
      if (sql.includes('SELECT retry_count')) return { rows: [job] };
      if (sql.includes('SELECT id, status')) {
        if (completed) return { rows: [] };
        return { rows: [active] };
      }
      if (sql.includes('SELECT lease_expires_at >')) return { rows: [{ valid: true }] };
      if (sql.includes("SET status = 'completed'")) completed = true;
      return { rows: [] };
    });
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: 'attempt-1' }] } as never);
    expect(await Execution.completeExecution('j', 'w', 'token')).toBe(true);
    expect(await Execution.completeExecution('j', 'w', 'token')).toBe(true);
    expect(c.query.mock.calls.filter(([sql]) => String(sql).includes("SET status = 'completed'") && String(sql).includes('job_executions'))).toHaveLength(1);
  });

  it('rejects a stale callback when its attempt is no longer active', async () => {
    clientWith((sql) => sql.includes('SELECT retry_count') ? { rows: [job] } : { rows: [] });
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    expect(await Execution.completeExecution('j', 'w', 'old-token')).toBe(false);
  });

  it('rejects an expired lease even before the recovery monitor runs', async () => {
    const c = clientWith((sql) => {
      if (sql.includes('SELECT retry_count')) return { rows: [job] };
      if (sql.includes('SELECT id, status')) return { rows: [active] };
      if (sql.includes('SELECT lease_expires_at >')) return { rows: [{ valid: false }] };
      return { rows: [] };
    });
    expect(await Execution.startExecution('j', 'w', 'expired-token')).toBe(false);
    expect(c.query.mock.calls.some(([sql]) => String(sql).includes('clock_timestamp()'))).toBe(true);
    expect(c.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'running'"))).toBe(false);
  });

  it('inserts progress logs with the exact validated execution ID', async () => {
    const c = clientWith((sql) => {
      if (sql.includes('SELECT retry_count')) return { rows: [job] };
      if (sql.includes('SELECT id, status')) return { rows: [active] };
      if (sql.includes('SELECT lease_expires_at >')) return { rows: [{ valid: true }] };
      return { rows: [] };
    });

    expect(await Execution.updateExecutionProgress('job-1', 'worker-1', 'lease-1', 25)).toBe(true);

    const insert = c.query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO execution_logs'));
    expect(insert?.[0]).toContain('job_id, worker_id, execution_id, level, message');
    expect(insert?.[1]).toEqual(['job-1', 'worker-1', 'attempt-1', 'Progress: 25%']);
    expect(c.query).toHaveBeenCalledWith('COMMIT');
  });

  it('does not insert progress logs for an invalid or stale attempt', async () => {
    const c = clientWith((sql) => sql.includes('SELECT retry_count') ? { rows: [job] } : { rows: [] });

    expect(await Execution.updateExecutionProgress('job-1', 'worker-1', 'stale-lease', 25)).toBe(false);
    expect(c.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO execution_logs'))).toBe(false);
    expect(c.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('marks the task failed when the initial attempt has exhausted its retries', async () => {
    const c = clientWith((sql) => {
      if (sql.includes('SELECT retry_count')) return { rows: [{ ...job, retry_count: 2, max_retries: 2 }] };
      if (sql.includes('SELECT id, status')) return { rows: [active] };
      if (sql.includes('SELECT lease_expires_at >')) return { rows: [{ valid: true }] };
      return { rows: [] };
    });
    expect(await Execution.failExecution('j', 'w', 'token', 'nope')).toBe(true);
    expect(c.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'failed'"))).toBe(true);
  });

  it('times out an expired lease and retries or fails using the persisted count', async () => {
    const c = clientWith((sql) => {
      if (sql.includes('SELECT retry_count, max_retries')) return { rows: [{ retry_count: 0, max_retries: 1, status: 'running' }] };
      if (sql.includes('SELECT id FROM job_executions')) return { rows: [{ id: 'a' }] };
      if (sql.includes('SELECT lease_expires_at <=')) return { rows: [{ expired: true }] };
      return { rows: [] };
    });
    vi.mocked(pool.query).mockResolvedValue({ rows: [{ id: 'a', job_id: 'j', worker_id: 'w' }] } as never);
    expect(await Execution.recoverExpiredExecutions(45)).toBe(1);
    expect(c.query.mock.calls.some(([sql, params]) => String(sql).includes('SET status = $2, finished_at') && params?.[1] === 'timed_out')).toBe(true);
    expect(c.query.mock.calls.some(([sql]) => String(sql).includes("status = 'pending'"))).toBe(true);
  });

  it('graceful deregistration schedules a retry when retries remain', async () => {
    const c = clientWith((sql) => {
      if (sql.includes('SELECT je.id, je.job_id')) return { rows: [{ id: 'a', job_id: 'j', retry_count: 0, max_retries: 1, execution_status: 'running', job_status: 'running' }] };
      if (sql.includes('SELECT status, retry_count, max_retries FROM background_jobs')) return { rows: [{ status: 'running', retry_count: 0, max_retries: 1 }] };
      if (sql.includes('SELECT id, status FROM job_executions')) return { rows: [{ id: 'a', status: 'running' }] };
      if (sql.includes('UPDATE workers') && sql.includes('RETURNING')) return { rows: [{ id: 'w', hostname: 'w', status: 'dead' }] };
      return { rows: [] };
    });
    expect(await Workers.deregisterWorker('w')).not.toBeNull();
    expect(c.query.mock.calls.some(([sql]) => String(sql).includes("status = 'pending'"))).toBe(true);
    expect(c.query.mock.calls.some(([sql, params]) => String(sql).includes('SET status = $2, finished_at') && params?.[1] === 'timed_out')).toBe(true);
  });

  it('graceful deregistration fails the task after retries are exhausted', async () => {
    const c = clientWith((sql) => {
      if (sql.includes('SELECT je.id, je.job_id')) return { rows: [{ id: 'a', job_id: 'j', retry_count: 1, max_retries: 1, execution_status: 'running', job_status: 'running' }] };
      if (sql.includes('SELECT status, retry_count, max_retries FROM background_jobs')) return { rows: [{ status: 'running', retry_count: 1, max_retries: 1 }] };
      if (sql.includes('SELECT id, status FROM job_executions')) return { rows: [{ id: 'a', status: 'running' }] };
      if (sql.includes('UPDATE workers') && sql.includes('RETURNING')) return { rows: [{ id: 'w', hostname: 'w', status: 'dead' }] };
      return { rows: [] };
    });
    expect(await Workers.deregisterWorker('w')).not.toBeNull();
    expect(c.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'failed'"))).toBe(true);
  });
});
