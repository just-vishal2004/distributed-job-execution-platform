import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeAttempt, executeJob, post, WorkerApiError } from '../workers/worker';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function response(status: number, body: unknown = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

const task = { id: 'j', executionId: 'e', name: 'task', payload: {}, attempt: 1, leaseToken: 'lease' };

describe('worker lifecycle HTTP handling', () => {
  it.each([
    [401, 'authentication'],
    [403, 'authentication'],
    [409, 'lease'],
    [500, 'server'],
  ] as const)('classifies HTTP %s without exposing response secrets', async (status, kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(status, { error: 'private response' })));
    await expect(post('/path', { leaseToken: 'sensitive-token' }, 'worker-secret'))
      .rejects.toMatchObject({ status, kind });
    try {
      await post('/path', undefined, 'worker-secret');
    } catch (err) {
      expect(err).toBeInstanceOf(WorkerApiError);
      expect((err as Error).message).not.toContain('sensitive-token');
      expect((err as Error).message).not.toContain('worker-secret');
      expect((err as Error).message).not.toContain('private response');
    }
  });

  it('backs off on 429 and reports rate limiting after bounded retries', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(response(429));
    vi.stubGlobal('fetch', fetchMock);
    const request = post('/path');
    const rejected = expect(request).rejects.toMatchObject({ kind: 'rate_limit', status: 429 });
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('classifies invalid JSON responses without returning their content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('secret body'); } }));
    await expect(post('/path')).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('classifies network errors and enforces a bounded request timeout', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket failed')));
    await expect(post('/path')).rejects.toMatchObject({ kind: 'network' });

    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })));
    const request = post('/path');
    const rejected = expect(request).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
  });

  it('does not execute task work after a rejected start', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(409));
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeJob(task, 'w', 'credential', new AbortController().signal))
      .rejects.toMatchObject({ kind: 'lease' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('aborts local execution on lease rejection and sends no later callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(409));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const onLeaseLost = vi.fn(() => controller.abort());
    await executeAttempt(task, 'w', 'credential', controller.signal, onLeaseLost);
    expect(onLeaseLost).toHaveBeenCalledOnce();
    expect(controller.signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not turn an API server failure into a task failure callback', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(executeAttempt(task, 'w', 'credential', new AbortController().signal, vi.fn()))
      .rejects.toMatchObject({ kind: 'server' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
