import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWorker } from '../workers/worker';

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('worker loop revocation behavior', () => {
  it('settles a cooperative task before acknowledging a heartbeat lease loss', async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    const calls: Array<{ path: string; body?: string }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, body: typeof init?.body === 'string' ? init.body : undefined });
      if (path.endsWith('/register')) return jsonResponse(201, { worker: { id: 'worker-1' }, credential: 'credential' });
      if (path.endsWith('/jobs/poll')) {
        pollCount++;
        return pollCount === 1
          ? jsonResponse(200, { job: { id: 'job-1', executionId: 'execution-1', name: 'task', payload: {}, attempt: 1, leaseToken: 'token' } })
          : jsonResponse(401, { error: 'stopped' });
      }
      if (path.endsWith('/heartbeat')) {
        return init?.body ? jsonResponse(409, { error: 'revoked' }) : jsonResponse(200, { state: 'idle' });
      }
      if (path.endsWith('/revocation-ack')) return jsonResponse(200, { acknowledged: true, released: true });
      if (path.endsWith('/deregister')) return jsonResponse(200, { worker: { id: 'worker-1' } });
      return jsonResponse(404, {});
    }));

    const taskRunner = vi.fn(async (_job, _workerId, _credential, signal: AbortSignal) => {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    });
    const running = runWorker('test-worker', taskRunner).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(taskRunner).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(15_000);
    await flushMicrotasks();
    const ackIndex = calls.findIndex(({ path }) => path.endsWith('/revocation-ack'));
    expect(ackIndex).toBeGreaterThan(-1);
    expect(calls[ackIndex]?.body).toContain('execution-1');
    expect(calls[ackIndex]?.body).toContain('job-1');
    expect(calls[ackIndex]?.body).toContain('token');
    await expect(running).resolves.toMatchObject({ kind: 'authentication' });
  });

  it('retires without acknowledging when the actual worker loop task ignores abort', async () => {
    vi.useFakeTimers();
    let pollCount = 0;
    let finishTask: (() => void) | undefined;
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      calls.push(path);
      if (path.endsWith('/register')) return jsonResponse(201, { worker: { id: 'worker-1' }, credential: 'credential' });
      if (path.endsWith('/jobs/poll')) {
        pollCount++;
        return pollCount === 1
          ? jsonResponse(200, { job: { id: 'job-1', executionId: 'execution-1', name: 'task', payload: {}, attempt: 1, leaseToken: 'token' } })
          : jsonResponse(401, {});
      }
      if (path.endsWith('/heartbeat')) return init?.body ? jsonResponse(409, {}) : jsonResponse(200, {});
      if (path.endsWith('/deregister')) return jsonResponse(200, { worker: { id: 'worker-1' } });
      return jsonResponse(404, {});
    }));
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const taskRunner = vi.fn(() => new Promise<void>((resolve) => { finishTask = resolve; }));
    const running = runWorker('test-worker', taskRunner).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();
    expect(taskRunner).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(20_000);
    await flushMicrotasks();
    expect(calls.some((path) => path.endsWith('/revocation-ack'))).toBe(false);
    expect(calls.some((path) => path.endsWith('/deregister'))).toBe(true);
    expect(exit).toHaveBeenCalledWith(1);

    finishTask?.();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushMicrotasks();
    await running;
  });
});
