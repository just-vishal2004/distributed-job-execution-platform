import { describe, expect, it, vi } from 'vitest';
import { post, SerialHeartbeatLoop, WorkerShutdownCoordinator } from '../workers/worker';

describe('worker shutdown and heartbeat coordination', () => {
  it('does not overlap heartbeat requests', async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const send = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const loop = new SerialHeartbeatLoop(10, send);
    loop.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(50);
    expect(send).toHaveBeenCalledTimes(1);
    release?.();
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(2);
    loop.stop();
    vi.useRealTimers();
  });

  it('aborts and waits for a cooperative task before deregistration', async () => {
    const lifecycle = new WorkerShutdownCoordinator();
    const controller = new AbortController();
    let finishTask: (() => void) | undefined;
    const task = new Promise<void>((resolve) => { finishTask = resolve; });
    controller.signal.addEventListener('abort', () => finishTask?.());
    lifecycle.trackTask(controller, task);
    const deregister = vi.fn(async () => undefined);
    await lifecycle.shutdown(100, deregister);
    expect(controller.signal.aborted).toBe(true);
    expect(deregister).toHaveBeenCalledOnce();
  });

  it('bounds shutdown when a task ignores AbortSignal', async () => {
    vi.useFakeTimers();
    const lifecycle = new WorkerShutdownCoordinator();
    const controller = new AbortController();
    const task = new Promise<void>(() => undefined);
    lifecycle.trackTask(controller, task);
    const deregister = vi.fn(async () => undefined);
    const shutdown = lifecycle.shutdown(100, deregister);
    await vi.advanceTimersByTimeAsync(100);
    await shutdown;
    expect(controller.signal.aborted).toBe(true);
    expect(deregister).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it('reports deregistration failure and shares one shutdown operation across signals', async () => {
    const lifecycle = new WorkerShutdownCoordinator();
    const deregister = vi.fn(async () => { throw new Error('offline'); });
    const first = lifecycle.shutdown(0, deregister);
    const second = lifecycle.shutdown(0, deregister);
    expect(first).toBe(second);
    await expect(first).rejects.toThrow('offline');
    expect(deregister).toHaveBeenCalledOnce();
    expect(lifecycle.isStopping).toBe(true);
  });

  it('aborts an in-flight API request before deregistration during shutdown', async () => {
    const lifecycle = new WorkerShutdownCoordinator();
    const requestController = new AbortController();
    const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('request aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const task = post('/blocked', {}, undefined, requestController.signal);
    lifecycle.trackTask(requestController, task);
    const deregister = vi.fn(async () => undefined);

    await lifecycle.shutdown(100, deregister);

    expect(requestController.signal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(deregister).toHaveBeenCalledOnce();
  });
});
