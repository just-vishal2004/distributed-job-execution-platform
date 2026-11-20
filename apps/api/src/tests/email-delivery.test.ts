import { beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../utils/logger';
import { createConfiguredResendEmailProvider, createResendEmailProvider } from '../modules/auth/email-delivery';

const resendMock = vi.hoisted(() => ({
  constructor: vi.fn(),
  send: vi.fn(),
}));

vi.mock('resend', () => ({
  Resend: class ResendMock {
    emails = { send: resendMock.send };

    constructor(apiKey: string) {
      resendMock.constructor(apiKey);
    }
  },
}));
vi.mock('../utils/logger', () => ({ logger: { warn: vi.fn() } }));

const message = {
  recordId: '11111111-1111-4111-8111-111111111111',
  recipient: 'recipient@example.com',
  rawToken: '11111111-1111-4111-8111-111111111111.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

describe('Resend verification email adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resendMock.constructor.mockImplementation(() => ({ emails: { send: resendMock.send } }));
    resendMock.send.mockResolvedValue({ data: { id: 'provider-email-id' }, error: null });
  });

  it('remains unavailable when server email settings are missing', () => {
    expect(createConfiguredResendEmailProvider({
      apiKey: undefined,
      from: undefined,
      appBaseUrl: 'http://localhost:3000',
    })).toBeNull();
    expect(createConfiguredResendEmailProvider({
      apiKey: 'server-key',
      from: undefined,
      appBaseUrl: 'http://localhost:3000',
    })).toBeNull();
    expect(resendMock.constructor).not.toHaveBeenCalled();
  });

  it('sends text and HTML content with a stable idempotency key', async () => {
    const provider = createResendEmailProvider({
      apiKey: 'server-key',
      from: 'no-reply@example.com',
      appBaseUrl: 'http://localhost:3000',
    });

    expect(await provider.sendVerificationEmail(message)).toEqual({ ok: true });
    expect(await provider.sendVerificationEmail(message)).toEqual({ ok: true });
    expect(resendMock.constructor).toHaveBeenCalledWith('server-key');
    const [email, options] = resendMock.send.mock.calls[0];
    expect(email.from).toBe('no-reply@example.com');
    expect(email.to).toEqual(['recipient@example.com']);
    expect(email.text).toContain('Verify your email within 24 hours');
    expect(email.html).toContain('href="http://localhost:3000/verify-email#token=');
    expect(options).toEqual({ idempotencyKey: `email-verification/${message.recordId}` });
    expect(resendMock.send.mock.calls[1][1]).toEqual(options);
  });

  it('handles provider-reported failure without logging its payload or token', async () => {
    resendMock.send.mockResolvedValueOnce({
      data: null,
      error: { name: 'validation_error', message: 'private provider detail', statusCode: 422 },
    });
    const provider = createResendEmailProvider({
      apiKey: 'server-key',
      from: 'no-reply@example.com',
      appBaseUrl: 'https://app.example.com',
    });

    expect(await provider.sendVerificationEmail(message)).toEqual({ ok: false, reason: 'provider', retryable: false });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith('Verification email delivery failed', {
      event: 'email_delivery_failed',
      provider: 'resend',
      operation: 'email_verification',
      failureKind: 'provider',
      statusCode: 422,
    });
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain('private provider detail');
    expect(logged).not.toContain(message.rawToken);
    expect(logged).not.toContain('server-key');
  });

  it('handles network failures without exposing exception details', async () => {
    resendMock.send.mockRejectedValueOnce(new Error('network response included a secret token'));
    const provider = createResendEmailProvider({
      apiKey: 'server-key',
      from: 'no-reply@example.com',
      appBaseUrl: 'https://app.example.com',
    });

    expect(await provider.sendVerificationEmail(message)).toEqual({ ok: false, reason: 'network', retryable: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(vi.mocked(logger.warn).mock.calls);
    expect(logged).not.toContain('secret token');
    expect(logged).not.toContain(message.rawToken);
    expect(logged).not.toContain('server-key');
  });
});
