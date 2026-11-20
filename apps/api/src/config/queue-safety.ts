export function isUnscopedQueueEnabled(): boolean {
  return process.env.NODE_ENV !== 'production'
    && process.env.UNSCOPED_QUEUE_ENABLED === 'true';
}
