import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError } from '../utils/errors';
import { errorHandler } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

vi.mock('../utils/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

function makeJsonApp(limit = '100kb'): express.Express {
  const app = express();
  app.use(express.json({ limit }));
  app.post('/unexpected', (_req, _res, next) => {
    next(new Error('SELECT password FROM users; Authorization: Bearer secret-token; cookie=session-secret'));
  });
  app.post('/validation', (req, _res, next) => {
    try {
      z.object({ name: z.string().min(2) }).parse(req.body);
      next(new Error('Expected validation to fail'));
    } catch (error) {
      next(error);
    }
  });
  app.post('/app-error', (_req, _res, next) => {
    next(new AppError('FORBIDDEN', 'Project access denied', 403));
  });
  app.post('/unrelated', (_req, _res, next) => {
    const error = Object.assign(new Error('Application failure'), {
      type: 'entity.parse.failed',
      status: 500,
    });
    next(error);
  });
  app.post('/unrelated-too-large', (_req, _res, next) => {
    const error = Object.assign(new Error('Application failure'), {
      type: 'entity.too.large',
      status: 500,
    });
    next(error);
  });
  app.use(errorHandler);
  return app;
}

describe('shared API error handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a generic 500 and logs only safe metadata for unexpected SQL errors', async () => {
    const response = await request(makeJsonApp())
      .post('/unexpected?token=query-secret')
      .send({ name: 'valid' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Unexpected request error', {
      event: 'unexpected_request_error',
      method: 'POST',
      route: '/unexpected',
      statusCode: 500,
    });
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).not.toContain('SELECT password');
    expect(logged).not.toContain('secret-token');
    expect(logged).not.toContain('session-secret');
    expect(logged).not.toContain('query-secret');
    expect(logged).not.toContain('Error:');
  });

  it('does not log secret-like values from non-Error unexpected values', async () => {
    const app = express();
    app.get('/secret', (_req, _res, next) => {
      next('jwt=jwt-secret; password=account-secret; lease_token=lease-secret');
    });
    app.use(errorHandler);

    const response = await request(app).get('/secret');
    expect(response.status).toBe(500);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Unexpected request error', {
      event: 'unexpected_request_error',
      method: 'GET',
      route: '/secret',
      statusCode: 500,
    });
    const logged = JSON.stringify(vi.mocked(logger.error).mock.calls);
    expect(logged).not.toContain('jwt-secret');
    expect(logged).not.toContain('account-secret');
    expect(logged).not.toContain('lease-secret');
  });

  it('preserves intentional AppError status and safe message', async () => {
    const response = await request(makeJsonApp()).post('/app-error').send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({
      error: { code: 'FORBIDDEN', message: 'Project access denied' },
    });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Request error', {
      code: 'FORBIDDEN',
      message: 'Project access denied',
      statusCode: 403,
    });
  });

  it('keeps Zod validation errors as controlled 400 responses', async () => {
    const response = await request(makeJsonApp()).post('/validation').send({ name: '' });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.error.message).toBe('Invalid request data');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('keeps malformed JSON as a controlled 400 response', async () => {
    const response = await request(makeJsonApp())
      .post('/unexpected')
      .set('Content-Type', 'application/json')
      .send('{"name":');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'VALIDATION_ERROR', message: 'Invalid JSON request body' },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('returns 413 for oversized JSON bodies', async () => {
    const response = await request(makeJsonApp('32b'))
      .post('/unexpected')
      .send({ value: 'a'.repeat(128) });

    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body is too large' },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ['/unrelated', 'entity.parse.failed'],
    ['/unrelated-too-large', 'entity.too.large'],
  ])('does not classify an unrelated %s error as a body-parser failure', async (path) => {
    const response = await request(makeJsonApp()).post(path).send({});

    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_ERROR');
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Unexpected request error', {
      event: 'unexpected_request_error',
      method: 'POST',
      route: path,
      statusCode: 500,
    });
  });
});
