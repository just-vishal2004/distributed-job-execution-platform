import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/pool';
import { acknowledgeRevocation, deregisterWorker } from '../services/worker.service';
import { stopRevokedAttempt } from '../workers/worker';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

const revoked = { executionId: 'execution-1', jobId: 'job-1', leaseToken: 'attempt-token' };

function mockAckClient(
  executionStatus: string,
  workerStatus: string,
  acknowledgedAt: Date | null = null,
) {
  const statements: string[] = [];
  const client = { query: vi.fn(async (sql: string) => {
    statements.push(sql);
    if (sql.includes('SELECT id FROM background_jobs')) return { rows: [{ id: 'job-1' }] };
    if (sql.includes('SELECT id, status, revocation_acknowledged_at')) {
      return { rows: [{ id: 'execution-1', status: executionStatus, revocation_acknowledged_at: acknowledgedAt }] };
    }
    if (sql.includes('SELECT status FROM workers')) return { rows: [{ status: workerStatus }] };
    if (sql.includes("UPDATE workers w SET status = 'idle'")) {
      return { rows: workerStatus === 'revoking' ? [{ id: 'worker-1' }] : [] };
    }
    return { rows: [] };
  }), release: vi.fn() };
  return { client, statements };
}

describe('worker revocation safety', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['assigned', 'running'])('rejects acknowledgement of an unexpired %s attempt without writes', async (status) => {
    const { client } = mockAckClient(status, 'revoking');
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect(await acknowledgeRevocation('worker-1', revoked)).toBeNull();
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('rejects a revoked attempt acknowledgement if the worker is busy', async () => {
    const { client } = mockAckClient('cancelled', 'busy');
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect(await acknowledgeRevocation('worker-1', revoked)).toBeNull();
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
  });

  it.each(['cancelled', 'timed_out'])('releases a revoking worker after exact %s acknowledgement', async (status) => {
    const { client, statements } = mockAckClient(status, 'revoking');
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect(await acknowledgeRevocation('worker-1', revoked)).toEqual({ acknowledged: true, released: true });
    expect(statements.findIndex((sql) => sql.includes('revocation_acknowledged_at = clock_timestamp()')))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("UPDATE workers w SET status = 'idle'")));
    expect(client.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE id = $1 AND job_id = $2 AND worker_id = $3 AND lease_token = $4'),
      ['execution-1', 'job-1', 'worker-1', 'attempt-token'],
    );
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('handles duplicate acknowledgement idempotently after release', async () => {
    const { client, statements } = mockAckClient('cancelled', 'idle', new Date());
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect(await acknowledgeRevocation('worker-1', revoked)).toEqual({ acknowledged: true, released: true });
    expect(statements.some((sql) => sql.startsWith('UPDATE'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('keeps a worker revoking until every revoked attempt is acknowledged', async () => {
    const acknowledged = new Set<string>();
    const client = { query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT id FROM background_jobs')) return { rows: [{ id: 'job-1' }] };
      if (sql.includes('SELECT id, status, revocation_acknowledged_at')) {
        return { rows: [{
          id: params?.[0], status: params?.[0] === 'execution-1' ? 'cancelled' : 'timed_out',
          revocation_acknowledged_at: acknowledged.has(String(params?.[0])) ? new Date() : null,
        }] };
      }
      if (sql.includes('SELECT status FROM workers')) return { rows: [{ status: 'revoking' }] };
      if (sql.includes('revocation_acknowledged_at = clock_timestamp()')) {
        acknowledged.add(String(params?.[0]));
        return { rows: [] };
      }
      if (sql.includes("UPDATE workers w SET status = 'idle'")) {
        return { rows: acknowledged.has('execution-1') && acknowledged.has('execution-2') ? [{ id: 'worker-1' }] : [] };
      }
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(client as never);

    expect(await acknowledgeRevocation('worker-1', revoked)).toEqual({ acknowledged: true, released: false });
    expect(await acknowledgeRevocation('worker-1', {
      executionId: 'execution-2', jobId: 'job-1', leaseToken: 'token-2',
    })).toEqual({ acknowledged: true, released: true });
  });

  it('does not release a newer busy assignment when an old acknowledgement is repeated', async () => {
    const { client, statements } = mockAckClient('cancelled', 'busy', new Date());
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect(await acknowledgeRevocation('worker-1', revoked)).toEqual({ acknowledged: true, released: false });
    expect(statements.some((sql) => sql.startsWith('UPDATE'))).toBe(false);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('rejects a stale token without changing availability', async () => {
    const { client } = mockAckClient('cancelled', 'revoking');
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id, status, revocation_acknowledged_at')) return { rows: [] };
      return { rows: [] };
    });
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect(await acknowledgeRevocation('worker-1', { ...revoked, leaseToken: 'stale-token' })).toBeNull();
    expect(client.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE'))).toBe(false);
  });

  it('does not acknowledge or release a worker when its task ignores abort', async () => {
    vi.useFakeTimers();
    const task = new Promise<void>(() => undefined);
    const acknowledge = vi.fn(async () => undefined);
    const retire = vi.fn(async () => undefined);
    const stopping = stopRevokedAttempt(task, 50, acknowledge, retire);
    await vi.advanceTimersByTimeAsync(50);
    expect(await stopping).toBe('retired');
    expect(acknowledge).not.toHaveBeenCalled();
    expect(retire).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('retiring a worker during revocation makes it dead without reopening a cancelled attempt', async () => {
    const client = { query: vi.fn(async (sql: string) => {
      if (sql.includes('SELECT je.id, je.job_id FROM job_executions')) return { rows: [] };
      if (sql.includes('UPDATE workers') && sql.includes('RETURNING')) return { rows: [{ id: 'worker-1', status: 'dead' }] };
      return { rows: [] };
    }), release: vi.fn() };
    vi.mocked(pool.connect).mockResolvedValue(client as never);
    expect(await deregisterWorker('worker-1')).not.toBeNull();
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes("SET status = 'pending'"))).toBe(false);
  });
});
