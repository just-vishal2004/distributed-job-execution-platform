import 'dotenv/config';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env';
import { connectDatabase } from './db/pool';
import { logger } from './utils/logger';
import { attachUser } from './middleware/auth';
import { errorHandler } from './middleware/errorHandler';
import { generalRateLimiter } from './middleware/rateLimiter';
import authRoutes from './modules/auth/auth.routes';
import jobRoutes from './routes/job.routes';
import workerRoutes from './routes/worker.routes';
import executionRoutes from './routes/execution.routes';
import projectRoutes from './routes/project.routes';
import { startScheduler } from './scheduler/scheduler';
import { startHeartbeatMonitor } from './monitor/heartbeat.monitor';
import { verifyDatabaseReadiness } from './db/readiness';
import { startBackgroundServicesWhenReady } from './startup';
import { startEmailVerificationDeliveryWorker } from './modules/auth/email-verification-worker';
import { startVerificationRateLimitCleanup } from './middleware/emailVerificationRateLimit';

const app = express();
const PORT = env.PORT;

// Security headers
app.use(helmet());

// Explicit CORS configuration: credentials enabled for HTTP-only cookies
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  }),
);

// Body size limit to prevent request flood attacks
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// Attach authenticated user identity if valid session cookie exists
app.use(attachUser);

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// General rate limiter on API routes
app.use('/api', generalRateLimiter);

// API route groups
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/workers', workerRoutes);
app.use('/api/workers', executionRoutes);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Route not found',
    },
  });
});

// Global error handler: must be the final middleware
app.use(errorHandler);

export { app };

async function start() {
  try {
    await connectDatabase();
    await startBackgroundServicesWhenReady(
      verifyDatabaseReadiness,
      startScheduler,
      startHeartbeatMonitor,
      startEmailVerificationDeliveryWorker,
      startVerificationRateLimitCleanup,
    );

    app.listen(PORT, () => {
      logger.info(`API server running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('Failed to start server', {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

// Start server when run directly
if (require.main === module) {
  start();
}
