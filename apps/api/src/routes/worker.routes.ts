import { Router, Request, Response } from 'express';
import * as WorkerService from '../services/worker.service';
import type { WorkerLeaseHeartbeatRequest, WorkerRevocationAcknowledgementRequest } from '@meridian/types';
import { requireWorker } from '../middleware/workerAuth';
import { requireAuth } from '../middleware/auth';

const router = Router();

const registryUnavailable = (_req: Request, res: Response) => {
  res.status(503).json({
    error: {
      code: 'RESOURCE_SCOPE_UNAVAILABLE',
      message: 'Worker registry operations are unavailable until project access controls are configured',
    },
  });
};

router.post('/register', requireAuth, registryUnavailable);
router.get('/', requireAuth, registryUnavailable);
router.get('/:id', requireAuth, registryUnavailable);

// POST /api/workers/:id/heartbeat: Worker signals it is still alive
router.post('/:id/heartbeat', requireWorker, async (req: Request, res: Response) => {
  const body: Record<string, unknown> = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  if (req.body !== undefined && (typeof req.body !== 'object' || Array.isArray(req.body))) {
    res.status(400).json({ error: 'Heartbeat body must be an object' });
    return;
  }
  const hasAttemptFields = ['executionId', 'jobId', 'leaseToken'].some((key) => key in body);
  let attempt: WorkerLeaseHeartbeatRequest | undefined;
  if (hasAttemptFields) {
    if (typeof body.executionId !== 'string' || typeof body.jobId !== 'string' || typeof body.leaseToken !== 'string') {
      res.status(400).json({ error: 'executionId, jobId, and leaseToken are required for an active execution heartbeat' });
      return;
    }
    attempt = { executionId: body.executionId, jobId: body.jobId, leaseToken: body.leaseToken };
  }
  try {
    const heartbeat = await WorkerService.heartbeat(req.params.id, attempt);

    if (!heartbeat) {
      // Worker is dead or does not exist: tell it to re-register
      res.status(410).json({
        error: 'Worker is no longer active. Please re-register.',
      });
      return;
    }

    if (!heartbeat.leaseValid) {
      res.status(heartbeat.state === 'attempt_required' ? 428 : 409).json({
        error: heartbeat.state === 'attempt_required'
          ? 'Poll for the active worker attempt before heartbeating'
          : 'Worker lease is no longer active',
      });
      return;
    }
    res.json({ state: heartbeat.state, worker: heartbeat.worker });
  } catch (err) {
    res.status(500).json({ error: 'Failed to process heartbeat' });
  }
});

router.post('/:id/revocation-ack', requireWorker, async (req: Request, res: Response) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  if (typeof body.executionId !== 'string' || typeof body.jobId !== 'string' || typeof body.leaseToken !== 'string') {
    res.status(400).json({ error: 'executionId, jobId, and leaseToken are required' });
    return;
  }
  const acknowledgement: WorkerRevocationAcknowledgementRequest = {
    executionId: body.executionId,
    jobId: body.jobId,
    leaseToken: body.leaseToken,
  };
  try {
    const result = await WorkerService.acknowledgeRevocation(req.params.id, acknowledgement);
    if (!result) {
      res.status(409).json({ error: 'Revocation acknowledgement does not match a revoked attempt' });
      return;
    }
    res.json(result);
  } catch {
    res.status(500).json({ error: 'Failed to acknowledge execution revocation' });
  }
});

// POST /api/workers/:id/deregister: Worker is shutting down gracefully
router.post('/:id/deregister', requireWorker, async (req: Request, res: Response) => {
  try {
    const worker = await WorkerService.deregisterWorker(req.params.id);

    if (!worker) {
      res.status(404).json({ error: 'Worker not found or already dead' });
      return;
    }

    res.json({ worker });
  } catch (err) {
    res.status(500).json({ error: 'Failed to deregister worker' });
  }
});

export default router;
