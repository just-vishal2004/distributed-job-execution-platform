import { logger } from '../utils/logger';
import { assignNextJob } from '../services/execution.service';
import { isUnscopedQueueEnabled } from '../config/queue-safety';

let isRunning = false;

async function runSchedulerCycle(): Promise<void> {
  let assigned = 0;
  while (await assignNextJob()) assigned++;
  if (assigned > 0) logger.info('Scheduler cycle complete', { jobsAssigned: assigned });
}

export function startScheduler(): void {
  if (!isUnscopedQueueEnabled()) {
    logger.warn('Global scheduler remains disabled because unscoped queue assignment is disabled');
    return;
  }

  const intervalMs = parseInt(process.env.SCHEDULER_INTERVAL_MS ?? '2000');
  logger.info('Scheduler started', { intervalMs });
  setInterval(async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      await runSchedulerCycle();
    } catch (err) {
      logger.error('Scheduler cycle failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      isRunning = false;
    }
  }, intervalMs);
}
