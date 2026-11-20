import { afterEach, describe, expect, it, vi } from 'vitest';
import { startScheduler } from '../scheduler/scheduler';

vi.mock('../services/execution.service', () => ({
  assignNextJob: vi.fn(),
}));

describe('global scheduler cutover guard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it('does not schedule assignment cycles when unscoped queue work is disabled', () => {
    vi.useFakeTimers();
    vi.stubEnv('UNSCOPED_QUEUE_ENABLED', 'false');

    startScheduler();

    expect(vi.getTimerCount()).toBe(0);
  });
});
