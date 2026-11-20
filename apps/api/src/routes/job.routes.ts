import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth';

const router = Router();

router.use(requireAuth);
router.use((_req: Request, res: Response) => {
  res.status(503).json({
    error: {
      code: 'RESOURCE_SCOPE_UNAVAILABLE',
      message: 'Job operations are unavailable until project access controls are configured',
    },
  });
});

export default router;
