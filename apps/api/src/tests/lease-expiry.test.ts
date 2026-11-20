import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/pool';
import { recoverExpiredExecutions } from '../services/execution.service';
import { heartbeat } from '../services/worker.service';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

const workerRow = {
  id: 'worker-1', hostname: 'host', status: 'busy', last_heartbeat: new Date(),
  registered_at: new Date(), metadata: {},
};

describe('lease expiry and heartbeat', () => {
  beforeEach(() => vi.resetAllMocks());

  it('does not renew an expired lease and reports lease loss', async () => {
    const statements: string[] = [];
    const client = { query: vi.fn(async (sql: string, _params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes('SELECT job_id FROM job_executions')) return { rows: [{ job_id: 'j' }] };
      if (sql.includes('SELECT status FROM background_jobs')) return { rows: [{ status: 'running' }] };
      if (sql.includes('SELECT id FROM job_executions')) return { rows: [{ id: 'a' }] };
      if (sql.includes('UPDATE job_executions')) return { rows: [] };
      if (sql.includes('UPDATE workers')) return { rows: [workerRow] };
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const result = await heartbeat('worker-1', { executionId: 'a', jobId: 'j', leaseToken: 'token' });
    expect(result?.leaseValid).toBe(false);
    expect(result?.state).toBe('revoked');
    const renewal = statements.find((sql) => sql.includes('UPDATE job_executions'));
    expect(renewal).toContain('lease_expires_at > clock_timestamp()');
    expect(statements.indexOf('BEGIN')).toBeLessThan(statements.findIndex((sql) => sql.includes('FOR UPDATE')));
  });

  it('renews a live lease using PostgreSQL time', async () => {
    const statements: string[] = [];
    const client = { query: vi.fn(async (sql: string, _params?: unknown[]) => {
      statements.push(sql);
      if (sql.includes('SELECT job_id FROM job_executions')) return { rows: [{ job_id: 'j' }] };
      if (sql.includes('SELECT status FROM background_jobs')) return { rows: [{ status: 'running' }] };
      if (sql.includes('SELECT id FROM job_executions')) return { rows: [{ id: 'a' }] };
      if (sql.includes('UPDATE job_executions')) return { rows: [{ id: 'a' }] };
      if (sql.includes('UPDATE workers')) return { rows: [workerRow] };
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect((await heartbeat('worker-1', { executionId: 'a', jobId: 'j', leaseToken: 'token' }))?.state).toBe('active');
    expect(statements.find((sql) => sql.includes('UPDATE job_executions'))).toContain('clock_timestamp()');
  });

  it('does not renew a lease after cancellation won the job lock', async () => {
    const statements: string[] = [];
    const client = { query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql.includes('SELECT job_id FROM job_executions')) return { rows: [{ job_id: 'j' }] };
      if (sql.includes('SELECT status FROM background_jobs')) return { rows: [{ status: 'cancelled' }] };
      if (sql.includes('SELECT id FROM job_executions')) return { rows: [] };
      if (sql.includes('UPDATE workers')) return { rows: [workerRow] };
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect((await heartbeat('worker-1', { executionId: 'a', jobId: 'j', leaseToken: 'token' }))?.leaseValid).toBe(false);
    expect(statements.some((sql) => sql.includes('UPDATE job_executions'))).toBe(false);
  });

  it('rejects an active heartbeat after cancellation closed the exact attempt', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT job_id FROM job_executions')) return { rows: [{ job_id: 'j' }] };
      if (sql.includes('SELECT status FROM background_jobs')) return { rows: [{ status: 'cancelled' }] };
      if (sql.includes('SELECT id FROM job_executions')) return { rows: [] };
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    const result = await heartbeat('worker-1', { executionId: 'a', jobId: 'j', leaseToken: 'old-token' });
    expect(result?.leaseValid).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE workers'))).toBe(false);
  });

  it('keeps a genuinely idle worker healthy', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id FROM job_executions')) return { rows: [] };
      if (sql.includes('UPDATE workers')) return { rows: [{ ...workerRow, status: 'idle' }] };
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect((await heartbeat('worker-1'))?.state).toBe('idle');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects an old attempt token without renewing a newer attempt', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT job_id FROM job_executions')) return { rows: [] };
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect((await heartbeat('worker-1', { executionId: 'old-attempt', jobId: 'j', leaseToken: 'old-token' }))?.leaseValid).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE job_executions'))).toBe(false);
  });

  it('rechecks a locked attempt so duplicate recovery runs only close it once', async () => {
    let attemptActive = true;
    let timeoutUpdates = 0;
    const makeClient = () => ({ query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT retry_count, max_retries, status')) return { rows: [{ retry_count: 0, max_retries: 1, status: 'running' }] };
      if (sql.includes('SELECT id FROM job_executions')) return { rows: attemptActive ? [{ id: 'a' }] : [] };
      if (sql.includes('SELECT lease_expires_at <= clock_timestamp')) return { rows: [{ expired: true }] };
      if (sql.includes('UPDATE job_executions')) {
        timeoutUpdates++;
        attemptActive = false;
      }
      return { rows: [] };
    }), release: vi.fn() });
    vi.mocked(pool.connect)
      .mockResolvedValueOnce(makeClient() as never)
      .mockResolvedValueOnce(makeClient() as never);
    vi.mocked(pool.query).mockImplementation(async () => ({
      rows: attemptActive ? [{ id: 'a', job_id: 'j', worker_id: 'w' }] : [],
    } as never));
    expect(await recoverExpiredExecutions(45)).toBe(1);
    expect(await recoverExpiredExecutions(45)).toBe(0);
    expect(timeoutUpdates).toBe(1);
  });

  it('orders recovery deterministically and limits each transaction batch', async () => {
    vi.mocked(pool.query).mockResolvedValue({ rows: [] } as never);
    expect(await recoverExpiredExecutions(45, 7)).toBe(0);
    const select = vi.mocked(pool.query).mock.calls.find(([sql]) => String(sql).includes('SELECT id, job_id, worker_id'));
    expect(select?.[0]).toContain('ORDER BY lease_expires_at, id LIMIT $1');
    expect(select?.[1]).toEqual([7]);
  });

  it('rolls back only the candidate that fails and continues the batch', async () => {
    const poolCandidateQuery = vi.mocked(pool.query);
    poolCandidateQuery.mockResolvedValue({ rows: [
      { id: 'bad', job_id: 'j1', worker_id: 'w1' },
      { id: 'good', job_id: 'j2', worker_id: 'w2' },
    ] } as never);
    const makeClient = (fail: boolean) => ({ query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT retry_count, max_retries, status')) return { rows: [{ retry_count: 0, max_retries: 2, status: 'running' }] };
      if (sql.includes('SELECT id FROM job_executions')) return { rows: [{ id: params?.[0] }] };
      if (sql.includes('SELECT lease_expires_at <= clock_timestamp')) return { rows: [{ expired: true }] };
      if (sql.includes('UPDATE job_executions') && fail) throw new Error('candidate update failed');
      return { rows: [] };
    }), release: vi.fn() });
    const failedClient = makeClient(true);
    const goodClient = makeClient(false);
    vi.mocked(pool.connect)
      .mockResolvedValueOnce(failedClient as never)
      .mockResolvedValueOnce(goodClient as never);

    expect(await recoverExpiredExecutions(45, 10)).toBe(1);
    expect(failedClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(goodClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('advances the recovery cursor past a repeatedly failing oldest candidate', async () => {
    const expiry = new Date('2026-01-01T00:00:00Z');
    const first = { id: '00000000-0000-0000-0000-000000000001', job_id: 'j1', worker_id: 'w1', lease_expires_at: expiry };
    const next = { id: '00000000-0000-0000-0000-000000000002', job_id: 'j2', worker_id: 'w2', lease_expires_at: expiry };
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [first] } as never)
      .mockResolvedValueOnce({ rows: [next] } as never);
    const makeClient = (failUpdate: boolean) => ({ query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT retry_count, max_retries, status')) return { rows: [{ retry_count: 0, max_retries: 2, status: 'running' }] };
      if (sql.includes('SELECT id FROM job_executions')) return { rows: [{ id: failUpdate ? first.id : next.id }] };
      if (sql.includes('SELECT lease_expires_at <= clock_timestamp')) return { rows: [{ expired: true }] };
      if (sql.includes('UPDATE job_executions') && failUpdate) throw new Error('persistent candidate failure');
      return { rows: [] };
    }), release: vi.fn() });
    const bad = makeClient(true);
    const later = makeClient(false);
    vi.mocked(pool.connect).mockResolvedValueOnce(bad as never).mockResolvedValueOnce(later as never);

    expect(await recoverExpiredExecutions(45, 1)).toBe(0);
    expect(await recoverExpiredExecutions(45, 1)).toBe(1);
    const secondScan = vi.mocked(pool.query).mock.calls[1];
    expect(secondScan[0]).toContain('(lease_expires_at, id) >');
    expect(secondScan[1]).toEqual([expiry, first.id, 1]);
    expect(bad.query).toHaveBeenCalledWith('ROLLBACK');
    expect(later.query).toHaveBeenCalledWith('COMMIT');
  });

  it('serializes competing recovery transactions and closes an attempt once', async () => {
    let attemptActive = true;
    let closes = 0;
    let jobLock = Promise.resolve();
    const candidate = { id: 'a', job_id: 'j', worker_id: 'w' };
    vi.mocked(pool.query).mockResolvedValue({ rows: [candidate] } as never);
    const makeClient = () => {
      let unlockJob: (() => void) | undefined;
      const query = vi.fn(async (sql: string) => {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql.includes('SELECT retry_count, max_retries, status')) {
          const previous = jobLock;
          jobLock = new Promise<void>((resolve) => { unlockJob = resolve; });
          await previous;
          return { rows: [{ retry_count: 0, max_retries: 1, status: 'running' }] };
        }
        if (sql.includes('SELECT id FROM job_executions')) return { rows: attemptActive ? [{ id: 'a' }] : [] };
        if (sql.includes('SELECT lease_expires_at <= clock_timestamp')) return { rows: [{ expired: true }] };
        if (sql.includes('UPDATE job_executions')) {
          closes++;
          attemptActive = false;
        }
        if (sql === 'COMMIT' || sql === 'ROLLBACK') unlockJob?.();
        return { rows: [] };
      });
      return { query, release: vi.fn() };
    };
    const first = makeClient();
    const second = makeClient();
    vi.mocked(pool.connect)
      .mockResolvedValueOnce(first as never)
      .mockResolvedValueOnce(second as never);

    const outcomes = await Promise.all([recoverExpiredExecutions(45), recoverExpiredExecutions(45)]);
    expect(outcomes.reduce((total, count) => total + count, 0)).toBe(1);
    expect(closes).toBe(1);
    expect(first.query.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE'))).toBe(true);
    expect(second.query.mock.calls.some(([sql]) => String(sql).includes('FOR UPDATE'))).toBe(true);
  });
});
