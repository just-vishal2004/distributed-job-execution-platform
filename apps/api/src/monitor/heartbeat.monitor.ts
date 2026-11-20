import { pool } from '../db/pool';
import { logger } from '../utils/logger';
import { recoverExpiredExecutions } from '../services/execution.service';

let monitorInFlight = false;

async function monitorWorkers(): Promise<void> {
  if (monitorInFlight) return;
  monitorInFlight = true;
  const timeout = Number(process.env.HEARTBEAT_TIMEOUT_SECONDS ?? 45);
  try {
    const recovered = await recoverExpiredExecutions(timeout);
    const { rowCount } = await pool.query(
      `UPDATE workers SET status = 'dead'
       WHERE status IN ('idle', 'revoking')
         AND last_heartbeat < clock_timestamp() - INTERVAL '1 second' * $1`, [timeout]);
    if (recovered || rowCount) logger.warn('Worker monitor completed', { recoveredExecutions: recovered, deadWorkers: rowCount });
  } catch (err) {
    logger.error('Heartbeat monitor recovery failed', { error: err instanceof Error ? err.message : String(err) });
  } finally {
    monitorInFlight = false;
  }
}

export function startHeartbeatMonitor(): void {
  const intervalMs = Number(process.env.HEARTBEAT_MONITOR_INTERVAL_MS ?? 30000);
  logger.info('Heartbeat monitor started', { intervalMs });
  void monitorWorkers();
  setInterval(() => void monitorWorkers(), intervalMs);
}
