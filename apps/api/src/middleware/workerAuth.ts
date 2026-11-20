import type { Request, Response, NextFunction } from 'express';
import { unauthenticated } from '../utils/errors';
import { authenticateWorker } from '../services/worker.service';

export async function requireWorker(
  req: Request, _res: Response, next: NextFunction,
): Promise<void> {
  const workerId = req.params.workerId ?? req.params.id;
  const credential = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!workerId || !credential) {
    next(unauthenticated('Worker credentials are required'));
    return;
  }
  try {
    if (!(await authenticateWorker(workerId, credential))) {
      next(unauthenticated('Invalid worker credentials'));
      return;
    }
    next();
  } catch (err) {
    next(err);
  }
}
