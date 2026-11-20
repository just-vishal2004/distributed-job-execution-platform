export async function startBackgroundServicesWhenReady(
  verifyReadiness: () => Promise<void>,
  startScheduler: () => void,
  startRecoveryMonitor: () => void,
  startEmailDeliveryWorker: () => void = () => undefined,
  startRateLimitCleanup: () => void = () => undefined,
): Promise<void> {
  await verifyReadiness();
  startScheduler();
  startRecoveryMonitor();
  startEmailDeliveryWorker();
  startRateLimitCleanup();
}
