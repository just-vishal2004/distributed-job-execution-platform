import 'dotenv/config';
import { logger } from '../utils/logger';
import type { WorkerLeaseHeartbeatRequest } from '@meridian/types';

const API_URL = process.env.API_URL ?? 'http://localhost:3001';
const POLL_INTERVAL_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 15000;
const REQUEST_TIMEOUT_MS = 5000;
const SHUTDOWN_GRACE_MS = 5000;

export type WorkerApiFailure = 'authentication' | 'lease' | 'attempt_required' | 'rate_limit' | 'server' | 'network' | 'timeout' | 'invalid_response' | 'http' | 'aborted';

export class WorkerApiError extends Error {
  constructor(public readonly kind: WorkerApiFailure, public readonly status: number) {
    super(kind === 'http' || kind === 'server' || kind === 'rate_limit'
      ? `Worker API request failed with HTTP ${status}`
      : `Worker API request failed (${kind})`);
    this.name = 'WorkerApiError';
  }
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new WorkerApiError('aborted', 0));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new WorkerApiError('aborted', 0));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function failureForStatus(status: number): WorkerApiFailure {
  if (status === 401 || status === 403) return 'authentication';
  if (status === 409) return 'lease';
  if (status === 428) return 'attempt_required';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'server';
  return 'http';
}

export async function post<T = Record<string, unknown>>(
  path: string,
  body?: unknown,
  credential?: string,
  signal?: AbortSignal,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (credential) headers.Authorization = `Bearer ${credential}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, REQUEST_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    };
    let response: Response;
    try {
      response = await fetch(`${API_URL}${path}`, {
        method: 'POST',
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      const kind: WorkerApiFailure = signal?.aborted ? 'aborted' : timedOut ? 'timeout' : 'network';
      cleanup();
      throw new WorkerApiError(kind, 0);
    }

    if (response.status === 429 && attempt < 3) {
      cleanup();
      await wait(250 * (2 ** attempt), signal);
      continue;
    }
    if (!response.ok) {
      cleanup();
      const kind = failureForStatus(response.status);
      throw new WorkerApiError(kind, response.status);
    }
    try {
      return await response.json() as T;
    } catch {
      if (signal?.aborted) throw new WorkerApiError('aborted', 0);
      if (timedOut) throw new WorkerApiError('timeout', 0);
      throw new WorkerApiError('invalid_response', response.status);
    } finally {
      cleanup();
    }
  }
  throw new WorkerApiError('rate_limit', 429);
}

export async function executeJob(
  job: { id: string; executionId: string; name: string; payload: unknown; attempt: number; leaseToken: string },
  workerId: string,
  credential: string,
  signal: AbortSignal,
): Promise<void> {
  logger.info('Executing job', { jobId: job.id, jobName: job.name, attempt: job.attempt });
  await post(`/api/workers/${workerId}/jobs/${job.id}/start`, { leaseToken: job.leaseToken }, credential, signal);

  for (const percent of [25, 50, 75, 100]) {
    await wait(1000 + Math.random() * 2000, signal);
    if (percent === 50 && job.attempt === 1 && Math.random() < 0.2) {
      throw new Error(`Simulated failure at ${percent}% for job ${job.name}`);
    }
    await post(`/api/workers/${workerId}/jobs/${job.id}/progress`, {
      workerId,
      leaseToken: job.leaseToken,
      percent,
    }, credential, signal);
    logger.info('Job progress', { jobId: job.id, percent });
  }
}

export function completeJob(workerId: string, jobId: string, leaseToken: string, credential: string, signal?: AbortSignal): Promise<void> {
  return post(`/api/workers/${workerId}/jobs/${jobId}/complete`, { leaseToken }, credential, signal);
}

export function failJob(workerId: string, jobId: string, leaseToken: string, credential: string, error: string, signal?: AbortSignal): Promise<void> {
  return post(`/api/workers/${workerId}/jobs/${jobId}/fail`, { leaseToken, error }, credential, signal);
}

type ActiveTask = { controller: AbortController; promise: Promise<unknown> };
type RevokedTaskContext = {
  controller: AbortController;
  lease: WorkerLeaseHeartbeatRequest;
  leaseLost: boolean;
  taskPromise?: Promise<void>;
  revocationPromise?: Promise<void>;
};

export async function waitForTaskStop(task: Promise<unknown>, graceMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stopped = await Promise.race([
    task.then(() => true, () => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), graceMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return stopped;
}

export async function stopRevokedAttempt(
  task: Promise<unknown>,
  graceMs: number,
  acknowledge: () => Promise<void>,
  retire: () => Promise<unknown>,
): Promise<'acknowledged' | 'retired'> {
  if (!(await waitForTaskStop(task, graceMs))) {
    await retire();
    return 'retired';
  }
  try {
    await acknowledge();
    return 'acknowledged';
  } catch {
    await retire();
    return 'retired';
  }
}

export class WorkerShutdownCoordinator {
  private stopping = false;
  private shutdownPromise?: Promise<void>;
  private activeTask?: ActiveTask;
  private readonly controller = new AbortController();

  get isStopping(): boolean { return this.stopping; }
  get signal(): AbortSignal { return this.controller.signal; }

  trackTask(controller: AbortController, promise: Promise<unknown>): void {
    this.activeTask = { controller, promise };
  }

  clearTask(promise: Promise<unknown>): void {
    if (this.activeTask?.promise === promise) this.activeTask = undefined;
  }

  shutdown(graceMs: number, deregister: () => Promise<unknown>): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.stopping = true;
    this.controller.abort();
    const active = this.activeTask;
    active?.controller.abort();
    this.shutdownPromise = (async () => {
      if (active) {
        let graceTimer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          active.promise.then(() => undefined, () => undefined),
          new Promise<void>((resolve) => { graceTimer = setTimeout(resolve, graceMs); }),
        ]);
        if (graceTimer) clearTimeout(graceTimer);
      }
      await deregister();
    })();
    return this.shutdownPromise;
  }
}

export class SerialHeartbeatLoop {
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private running = false;
  private stopped = false;

  constructor(private readonly intervalMs: number, private readonly send: (signal: AbortSignal) => Promise<void>) {}

  start(): void {
    if (!this.stopped && !this.timer) this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.controller?.abort();
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.stopped || this.running) return;
    this.running = true;
    this.controller = new AbortController();
    try {
      await this.send(this.controller.signal);
    } finally {
      this.running = false;
      this.controller = undefined;
      this.schedule(this.intervalMs);
    }
  }
}

async function register(hostname: string): Promise<{ id: string; credential: string }> {
  const data = await post<{ worker: { id: string }; credential: string }>('/api/workers/register', {
    hostname,
    metadata: { pid: process.pid },
  });
  return { id: data.worker.id, credential: data.credential };
}

async function pollForJob(workerId: string, credential: string, signal: AbortSignal) {
  const data = await post<{ job: { id: string; executionId: string; name: string; payload: unknown; attempt: number; leaseToken: string } | null }>(
    `/api/workers/${workerId}/jobs/poll`, undefined, credential, signal,
  );
  return data.job ?? null;
}

export async function executeAttempt(
  job: { id: string; executionId: string; name: string; payload: unknown; attempt: number; leaseToken: string },
  workerId: string,
  credential: string,
  signal: AbortSignal,
  onLeaseLost: () => void,
): Promise<void> {
  try {
    await executeJob(job, workerId, credential, signal);
  } catch (err) {
    if (err instanceof WorkerApiError) {
      if (err.kind === 'lease') onLeaseLost();
      if (err.kind === 'authentication') throw err;
      if (err.kind !== 'lease') throw err;
      return;
    }
    if (signal.aborted) return;
    try {
      await failJob(workerId, job.id, job.leaseToken, credential,
        err instanceof Error ? err.message : 'Task handler failed', signal);
      logger.info('Job failure recorded', { jobId: job.id });
    } catch (callbackError) {
      if (callbackError instanceof WorkerApiError && callbackError.kind === 'lease') {
        onLeaseLost();
        return;
      }
      throw callbackError;
    }
    return;
  }

  if (signal.aborted) return;
  try {
    await completeJob(workerId, job.id, job.leaseToken, credential, signal);
    logger.info('Job completed successfully', { jobId: job.id });
  } catch (err) {
    if (err instanceof WorkerApiError && err.kind === 'lease') {
      onLeaseLost();
      return;
    }
    throw err;
  }
}

export async function runWorker(
  hostname: string,
  taskRunner: typeof executeAttempt = executeAttempt,
): Promise<void> {
  logger.info('Worker starting', { hostname });
  const registered = await register(hostname);
  const { id: workerId, credential } = registered;
  logger.info('Worker registered', { workerId, hostname });

  const lifecycle = new WorkerShutdownCoordinator();
  let activeContext: RevokedTaskContext | undefined;
  let heartbeatLoop: SerialHeartbeatLoop | undefined;
  const deregister = () => post(`/api/workers/${workerId}/deregister`, undefined, credential);
  let beginRevocation: (context: RevokedTaskContext) => void;
  const retireUnownedWorker = () => {
    heartbeatLoop?.stop();
    void lifecycle.shutdown(SHUTDOWN_GRACE_MS, deregister).then(() => process.exit(1)).catch((err) => {
      logger.error('Could not retire revoked worker; it remains unavailable for operator recovery', {
        error: err instanceof WorkerApiError ? err.kind : 'request failed',
      });
      process.exit(1);
    });
  };
  const sendHeartbeat = async (signal: AbortSignal) => {
    if (lifecycle.isStopping) return;
    const context = activeContext;
    try {
      await post(`/api/workers/${workerId}/heartbeat`, context?.lease, credential, signal);
    } catch (err) {
      if (lifecycle.isStopping) return;
      if (err instanceof WorkerApiError && err.kind === 'attempt_required' && !context) return;
      if (err instanceof WorkerApiError && err.kind === 'lease') {
        if (context && activeContext === context) {
          beginRevocation(context);
          logger.warn('Worker lease revoked; stopping current execution', { jobId: context.lease.jobId });
        } else if (!context) {
          logger.warn('Idle worker was revoked; retiring before it can poll again');
          retireUnownedWorker();
        }
      } else if (err instanceof WorkerApiError && err.kind === 'authentication') {
        heartbeatLoop?.stop();
        logger.error('Worker authentication rejected; stopping worker');
        void lifecycle.shutdown(SHUTDOWN_GRACE_MS, async () => undefined)
          .then(() => process.exit(1))
          .catch(() => process.exit(1));
      } else if (context && activeContext === context) {
        heartbeatLoop?.stop();
        context.controller.abort();
        logger.error('Unable to confirm active lease; stopping worker', {
          error: err instanceof WorkerApiError ? err.kind : 'request failed',
        });
        void lifecycle.shutdown(SHUTDOWN_GRACE_MS, async () => undefined)
          .then(() => process.exit(1))
          .catch(() => process.exit(1));
      } else {
        logger.warn('Worker heartbeat failed', { error: err instanceof WorkerApiError ? err.kind : 'request failed' });
      }
    }
  };

  heartbeatLoop = new SerialHeartbeatLoop(HEARTBEAT_INTERVAL_MS, sendHeartbeat);
  beginRevocation = (context) => {
    if (context.revocationPromise) return;
    context.leaseLost = true;
    context.controller.abort();
    heartbeatLoop?.stop();
    const taskPromise = context.taskPromise;
    if (!taskPromise) {
      logger.error('Revoked task has no completion handle; keeping worker unavailable');
      context.revocationPromise = (async () => {
        try {
          await deregister();
        } catch {
          logger.error('Could not retire revoked worker; it remains unavailable for operator recovery');
        }
        process.exit(1);
      })();
      return;
    }
    context.revocationPromise = (async () => {
      try {
        const outcome = await stopRevokedAttempt(taskPromise, SHUTDOWN_GRACE_MS, async () => {
          const result = await post<{ acknowledged: boolean; released: boolean }>(
            `/api/workers/${workerId}/revocation-ack`, context.lease, credential,
          );
          if (!result.acknowledged || !result.released) throw new WorkerApiError('lease', 409);
        }, deregister);
        if (lifecycle.isStopping) return;
        if (outcome === 'retired') {
          logger.error('Revoked task did not stop or could not be acknowledged; worker retired', { jobId: context.lease.jobId });
          process.exit(1);
          return;
        }
        if (activeContext === context) activeContext = undefined;
        heartbeatLoop = new SerialHeartbeatLoop(HEARTBEAT_INTERVAL_MS, sendHeartbeat);
        heartbeatLoop.start();
      } catch (err) {
        logger.error('Revocation stop procedure failed; worker remains unavailable', {
          error: err instanceof WorkerApiError ? err.kind : 'request failed',
        });
        process.exit(1);
      }
    })();
  };
  const onShutdown = () => {
    heartbeatLoop?.stop();
    void lifecycle.shutdown(SHUTDOWN_GRACE_MS, deregister).then(() => process.exit(0)).catch((err) => {
      logger.error('Worker deregistration failed during shutdown', {
        error: err instanceof WorkerApiError ? err.kind : 'request failed',
      });
      process.exit(1);
    });
  };
  process.on('SIGTERM', onShutdown);
  process.on('SIGINT', onShutdown);
  heartbeatLoop.start();

  try {
    while (!lifecycle.isStopping) {
      let job;
      try {
        job = await pollForJob(workerId, credential, lifecycle.signal);
      } catch (err) {
        if (lifecycle.isStopping) break;
        if (err instanceof WorkerApiError && err.kind === 'authentication') throw err;
        if (err instanceof WorkerApiError && err.kind === 'http') throw err;
        logger.warn('Job poll failed; retrying after backoff', {
          error: err instanceof WorkerApiError ? err.kind : 'request failed',
        });
        await wait(POLL_INTERVAL_MS, lifecycle.signal).catch(() => undefined);
        continue;
      }
      if (lifecycle.isStopping) break;
      if (!job) {
        await wait(POLL_INTERVAL_MS, lifecycle.signal).catch(() => undefined);
        continue;
      }

      const controller = new AbortController();
      const lease = { executionId: job.executionId, jobId: job.id, leaseToken: job.leaseToken };
      const context: RevokedTaskContext = { controller, lease, leaseLost: false };
      activeContext = context;
      const taskPromise = taskRunner(job, workerId, credential, controller.signal, () => beginRevocation(context));
      context.taskPromise = taskPromise;
      lifecycle.trackTask(controller, taskPromise);
      try {
        await taskPromise;
        if (context.revocationPromise) await context.revocationPromise;
      } catch (err) {
        if (lifecycle.isStopping) break;
        if (context.leaseLost) {
          if (context.revocationPromise) await context.revocationPromise;
        } else {
          if (err instanceof WorkerApiError && err.kind === 'authentication') throw err;
          if (err instanceof WorkerApiError && err.kind === 'rate_limit') {
            controller.abort();
            throw err;
          }
          if (err instanceof WorkerApiError) {
            controller.abort();
            logger.error('Task outcome is uncertain; worker will stop for lease recovery', { error: err.kind, jobId: job.id });
            throw err;
          }
          throw err;
        }
      } finally {
        lifecycle.clearTask(taskPromise);
        if (activeContext === context) activeContext = undefined;
      }
      if (!lifecycle.isStopping) await wait(500, lifecycle.signal).catch(() => undefined);
    }
  } finally {
    heartbeatLoop.stop();
    process.removeListener('SIGTERM', onShutdown);
    process.removeListener('SIGINT', onShutdown);
  }

  await lifecycle.shutdown(SHUTDOWN_GRACE_MS, deregister);
}

const hostname = process.argv[2] ?? `worker-${process.pid}`;
if (require.main === module) {
  runWorker(hostname).catch((err) => {
    logger.error('Worker stopped', { error: err instanceof WorkerApiError ? err.kind : 'worker failed' });
    process.exit(1);
  });
}
