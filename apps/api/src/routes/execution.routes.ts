import { Router, Request, Response } from 'express';
import * as ExecutionService from '../services/execution.service';
import { requireWorker } from '../middleware/workerAuth';

const router = Router();
router.use('/:workerId', requireWorker);

function sendTransitionResult(res: Response, changed: boolean): void {
  if (!changed) {
    res.status(409).json({ error: 'Execution lease is invalid, expired, or no longer active' });
    return;
  }
  res.json({ ok: true });
}

router.post('/:workerId/jobs/poll', async (req: Request, res: Response) => {
  try {
    const job = await ExecutionService.pollAssignedJob(req.params.workerId);
    res.json({ job });
  } catch {
    res.status(500).json({ error: 'Failed to poll for background job' });
  }
});

router.post('/:workerId/jobs/:jobId/start', async (req: Request, res: Response) => {
  if (typeof req.body?.leaseToken !== 'string') {
    res.status(400).json({ error: 'leaseToken is required' });
    return;
  }
  try {
    sendTransitionResult(res, await ExecutionService.startExecution(req.params.jobId, req.params.workerId, req.body.leaseToken));
  } catch {
    res.status(500).json({ error: 'Failed to mark job as started' });
  }
});

router.post('/:workerId/jobs/:jobId/progress', async (req: Request, res: Response) => {
  const { percent, leaseToken } = req.body ?? {};
  if (!Number.isFinite(percent) || percent < 0 || percent > 100 || typeof leaseToken !== 'string') {
    res.status(400).json({ error: 'percent and leaseToken are required' });
    return;
  }
  try {
    sendTransitionResult(res, await ExecutionService.updateExecutionProgress(req.params.jobId, req.params.workerId, leaseToken, percent));
  } catch {
    res.status(500).json({ error: 'Failed to update progress' });
  }
});

router.post('/:workerId/jobs/:jobId/complete', async (req: Request, res: Response) => {
  if (typeof req.body?.leaseToken !== 'string') {
    res.status(400).json({ error: 'leaseToken is required' });
    return;
  }
  try {
    sendTransitionResult(res, await ExecutionService.completeExecution(req.params.jobId, req.params.workerId, req.body.leaseToken));
  } catch {
    res.status(500).json({ error: 'Failed to complete job' });
  }
});

router.post('/:workerId/jobs/:jobId/fail', async (req: Request, res: Response) => {
  const { leaseToken, error } = req.body ?? {};
  if (typeof leaseToken !== 'string' || (error !== undefined && typeof error !== 'string')) {
    res.status(400).json({ error: 'leaseToken and an optional error string are required' });
    return;
  }
  try {
    sendTransitionResult(res, await ExecutionService.failExecution(req.params.jobId, req.params.workerId, leaseToken, error ?? 'Unknown error'));
  } catch {
    res.status(500).json({ error: 'Failed to record job failure' });
  }
});

export default router;
