import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../db/pool';
import { getBackgroundJobWithExecutions } from '../services/background-job.service';

vi.mock('../db/pool', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));

describe('background job execution logs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns nullable execution associations while preserving the ordered log projection', async () => {
    const earlier = new Date('2026-01-01T00:00:00.000Z');
    const later = new Date('2026-01-01T00:00:01.000Z');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{
        id: 'job-1', name: 'task', payload: {}, status: 'completed', priority: 5,
        max_retries: 0, retry_count: 0, scheduled_at: null,
        created_at: earlier, updated_at: later,
      }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
      .mockResolvedValueOnce({ rows: [
        { id: 'log-1', job_id: 'job-1', worker_id: null, executionId: null, level: 'info', message: 'historical', created_at: earlier },
        { id: 'log-2', job_id: 'job-1', worker_id: 'worker-1', executionId: 'attempt-1', level: 'info', message: 'progress', created_at: later },
      ] } as never);

    const result = await getBackgroundJobWithExecutions('job-1');
    const [jobQuery, executionsQuery, logsQuery] = vi.mocked(pool.query).mock.calls;

    expect(result?.logs.map((log) => log.id)).toEqual(['log-1', 'log-2']);
    expect(result?.logs[0].executionId).toBeNull();
    expect(result?.logs[1].executionId).toBe('attempt-1');
    expect(jobQuery?.[0]).toContain('FROM background_jobs');
    expect(executionsQuery?.[0]).toContain('FROM job_executions');
    expect(logsQuery?.[0]).toContain('execution_id AS "executionId"');
    expect(logsQuery?.[0]).toContain('WHERE job_id = $1 ORDER BY created_at ASC');
    expect(logsQuery?.[1]).toEqual(['job-1']);
    expect(Object.keys(result?.logs[0] ?? {})).toEqual([
      'id', 'job_id', 'worker_id', 'executionId', 'level', 'message', 'created_at',
    ]);
  });
});
