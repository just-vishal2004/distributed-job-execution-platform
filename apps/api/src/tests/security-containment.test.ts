import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { pool } from '../db/pool';
import { app } from '../index';
import { getBackgroundJobWithExecutions } from '../services/background-job.service';
import { COOKIE_NAME, signToken } from '../utils/token';

vi.mock('../db/pool', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  connectDatabase: vi.fn(),
}));

const userId = 'user-1';
const sessionId = 'session-1';

function userCookie() {
  const token = signToken({ sub: userId, jti: sessionId, role: 'candidate' });
  return `${COOKIE_NAME}=${token}`;
}

describe('security containment routes', () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ['list jobs', () => request(app).get('/api/jobs')],
    ['submit a job', () => request(app).post('/api/jobs').send({ name: 'test' })],
    ['read job details', () => request(app).get('/api/jobs/job-1')],
    ['cancel a job', () => request(app).delete('/api/jobs/job-1')],
  ])('rejects anonymous requests that attempt to %s', async (_name, sendRequest) => {
    const response = await sendRequest();
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it.each([
    ['list jobs', () => request(app).get('/api/jobs')],
    ['submit a job', () => request(app).post('/api/jobs').send({ name: 'test' })],
    ['read job details', () => request(app).get('/api/jobs/job-1')],
    ['cancel a job', () => request(app).delete('/api/jobs/job-1')],
  ])('keeps authenticated users out of the unscoped global queue when they %s', async (_name, sendRequest) => {
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ user_id: userId, expires_at: new Date(Date.now() + 60_000) }],
    } as never);
    const response = await sendRequest().set('Cookie', userCookie());
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('RESOURCE_SCOPE_UNAVAILABLE');
    expect(JSON.stringify(response.body)).not.toContain('lease_token');
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('rejects anonymous worker registration without creating a credential', async () => {
    const response = await request(app)
      .post('/api/workers/register')
      .send({ hostname: 'untrusted-worker' });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(pool.query).not.toHaveBeenCalled();
  });

  it('keeps authenticated users out of the unscoped worker registry and registration', async () => {
    vi.mocked(pool.query).mockResolvedValue({
      rows: [{ user_id: userId, expires_at: new Date(Date.now() + 60_000) }],
    } as never);
    const cookie = userCookie();
    const registration = await request(app)
      .post('/api/workers/register')
      .set('Cookie', cookie)
      .send({ hostname: 'untrusted-worker' });
    const listing = await request(app).get('/api/workers').set('Cookie', cookie);
    const detail = await request(app).get('/api/workers/worker-1').set('Cookie', cookie);

    expect(registration.status).toBe(503);
    expect(listing.status).toBe(503);
    expect(detail.status).toBe(503);
    expect(JSON.stringify(registration.body)).not.toContain('credential');
    expect(pool.query).toHaveBeenCalledTimes(3);
    expect(vi.mocked(pool.query).mock.calls.every(([sql]) => !String(sql).includes('INSERT INTO workers'))).toBe(true);
  });

  it('preserves polling for a worker with a valid worker credential', async () => {
    vi.stubEnv('UNSCOPED_QUEUE_ENABLED', 'false');
    const credential = 'valid-test-worker-credential';
    const credentialHash = createHash('sha256').update(credential).digest('hex');
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{ credential_hash: credentialHash, status: 'idle' }] } as never);

    const response = await request(app)
      .post('/api/workers/worker-1/jobs/poll')
      .set('Authorization', `Bearer ${credential}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ job: null });
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it('keeps worker-authenticated callbacks available for an existing active attempt', async () => {
    const credential = 'valid-test-worker-credential';
    const credentialHash = createHash('sha256').update(credential).digest('hex');
    vi.mocked(pool.query).mockResolvedValueOnce({
      rows: [{ credential_hash: credentialHash, status: 'busy' }],
    } as never);
    const lifecycleQuery = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT retry_count, max_retries, status')) {
        return { rows: [{ retry_count: 0, max_retries: 2, status: 'running' }] };
      }
      if (sql.includes('SELECT id, status FROM job_executions')) {
        return { rows: [{ id: 'execution-1', status: 'running' }] };
      }
      if (sql.includes('SELECT lease_expires_at > clock_timestamp()')) {
        return { rows: [{ valid: true }] };
      }
      return { rows: [] };
    });
    vi.mocked(pool.connect).mockResolvedValue({ query: lifecycleQuery, release: vi.fn() } as never);

    const response = await request(app)
      .post('/api/workers/worker-1/jobs/job-1/complete')
      .set('Authorization', `Bearer ${credential}`)
      .send({ leaseToken: 'attempt-lease' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(lifecycleQuery.mock.calls.some(([sql]) => sql.includes("SET status = 'completed'"))).toBe(true);
  });

  it('does not select or return lease tokens in job execution history', async () => {
    vi.mocked(pool.query)
      .mockResolvedValueOnce({ rows: [{
        id: 'job-1', name: 'task', payload: {}, status: 'completed', priority: 5,
        max_retries: 0, retry_count: 0, scheduled_at: null,
        created_at: new Date(), updated_at: new Date(),
      }] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: 'execution-1', job_id: 'job-1', worker_id: 'worker-1', attempt: 1,
        status: 'completed', started_at: new Date(), finished_at: new Date(),
        error_message: null, worker_hostname: 'worker',
      }] } as never)
      .mockResolvedValueOnce({ rows: [{
        id: 'log-1', job_id: 'job-1', worker_id: 'worker-1', level: 'info',
        message: 'completed', created_at: new Date(),
      }] } as never);

    const result = await getBackgroundJobWithExecutions('job-1');
    const statements = vi.mocked(pool.query).mock.calls.map(([sql]) => String(sql));

    expect(result?.executions).toHaveLength(1);
    expect(statements.every((sql) => !/SELECT\s+\*/i.test(sql))).toBe(true);
    expect(statements.every((sql) => !sql.includes('je.*'))).toBe(true);
    expect(statements.every((sql) => !sql.includes('lease_token'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('lease_token');
  });

  it('rejects a signed token whose subject does not own its session', async () => {
    vi.mocked(pool.query).mockResolvedValueOnce({ rows: [] } as never);
    const token = signToken({ sub: userId, jti: sessionId, role: 'candidate' });

    const response = await request(app)
      .get('/api/auth/me')
      .set('Cookie', `${COOKIE_NAME}=${token}`);

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining('AND user_id = $2'), [sessionId, userId]);
  });
});
