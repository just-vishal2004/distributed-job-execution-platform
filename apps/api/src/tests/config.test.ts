import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const knownTemplateSecret = 'change_me_to_a_secure_random_string_with_at_least_32_characters';
const testJwtSecret = 'test-only-jwt-secret-long-enough-for-validation';
const configPath = path.resolve(__dirname, '../config/env.ts');
const tsxRegister = require.resolve('tsx/cjs');

type EnvironmentOverrides = Record<string, string | undefined>;

interface ParsedConfiguration {
  NODE_ENV: string;
  PORT: number;
  DATABASE_URL: string;
  JWT_EXPIRES_IN: string;
  CORS_ORIGIN: string;
  APP_BASE_URL: string;
  SCHEDULER_INTERVAL_MS: number;
  HEARTBEAT_MONITOR_INTERVAL_MS: number;
  HEARTBEAT_TIMEOUT_SECONDS: number;
  UNSCOPED_QUEUE_ENABLED: string;
  LOG_LEVEL: string;
  RESEND_API_KEY_CONFIGURED: boolean;
  EMAIL_FROM: string | null;
  EMAIL_DELIVERY_ENCRYPTION_KEY_CONFIGURED: boolean;
}

function loadConfiguration(overrides: EnvironmentOverrides = {}) {
  const childEnvironment: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    DATABASE_URL: 'postgresql://localhost:5432/config_test',
    JWT_SECRET: testJwtSecret,
    RESEND_API_KEY: '',
    EMAIL_FROM: '',
    EMAIL_DELIVERY_ENCRYPTION_KEY: '',
  };

  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete childEnvironment[key];
    } else {
      childEnvironment[key] = value;
    }
  }

  const script = `
    const { env } = require(${JSON.stringify(configPath)});
    process.stdout.write(JSON.stringify({
      NODE_ENV: env.NODE_ENV,
      PORT: env.PORT,
      DATABASE_URL: env.DATABASE_URL,
      JWT_EXPIRES_IN: env.JWT_EXPIRES_IN,
      CORS_ORIGIN: env.CORS_ORIGIN,
      APP_BASE_URL: env.APP_BASE_URL,
      SCHEDULER_INTERVAL_MS: env.SCHEDULER_INTERVAL_MS,
      HEARTBEAT_MONITOR_INTERVAL_MS: env.HEARTBEAT_MONITOR_INTERVAL_MS,
      HEARTBEAT_TIMEOUT_SECONDS: env.HEARTBEAT_TIMEOUT_SECONDS,
      UNSCOPED_QUEUE_ENABLED: env.UNSCOPED_QUEUE_ENABLED,
      LOG_LEVEL: env.LOG_LEVEL,
      RESEND_API_KEY_CONFIGURED: env.RESEND_API_KEY !== undefined,
      EMAIL_FROM: env.EMAIL_FROM ?? null,
      EMAIL_DELIVERY_ENCRYPTION_KEY_CONFIGURED: env.EMAIL_DELIVERY_ENCRYPTION_KEY !== undefined,
    }));
  `;

  const result = spawnSync(
    process.execPath,
    ['-r', tsxRegister, '-e', script],
    { encoding: 'utf8', env: childEnvironment },
  );

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    parsed: result.status === 0
      ? JSON.parse(result.stdout) as ParsedConfiguration
      : undefined,
  };
}

describe('environment schema behavior', () => {
  it('applies defaults and returns parsed output values', () => {
    const result = loadConfiguration();

    expect(result.status).toBe(0);
    expect(result.parsed).toEqual({
      NODE_ENV: 'development',
      PORT: 3001,
      DATABASE_URL: 'postgresql://localhost:5432/config_test',
      JWT_EXPIRES_IN: '7d',
      CORS_ORIGIN: 'http://localhost:3000',
      APP_BASE_URL: 'http://localhost:3000',
      SCHEDULER_INTERVAL_MS: 2000,
      HEARTBEAT_MONITOR_INTERVAL_MS: 30000,
      HEARTBEAT_TIMEOUT_SECONDS: 45,
      UNSCOPED_QUEUE_ENABLED: 'false',
      LOG_LEVEL: 'info',
      RESEND_API_KEY_CONFIGURED: false,
      EMAIL_FROM: null,
      EMAIL_DELIVERY_ENCRYPTION_KEY_CONFIGURED: false,
    });
  });

  it('coerces numeric environment values and accepts PORT boundaries', () => {
    const result = loadConfiguration({
      PORT: '1',
      SCHEDULER_INTERVAL_MS: '1250',
      HEARTBEAT_MONITOR_INTERVAL_MS: '25000',
      HEARTBEAT_TIMEOUT_SECONDS: '45',
    });

    expect(result.status).toBe(0);
    expect(result.parsed?.PORT).toBe(1);
    expect(result.parsed?.SCHEDULER_INTERVAL_MS).toBe(1250);
    expect(result.parsed?.HEARTBEAT_MONITOR_INTERVAL_MS).toBe(25000);
    expect(result.parsed?.HEARTBEAT_TIMEOUT_SECONDS).toBe(45);
    expect(loadConfiguration({ PORT: '65535' }).parsed?.PORT).toBe(65535);

    const zeroTimers = loadConfiguration({
      SCHEDULER_INTERVAL_MS: '0',
      HEARTBEAT_MONITOR_INTERVAL_MS: '0',
      HEARTBEAT_TIMEOUT_SECONDS: '0',
    });
    expect(zeroTimers.status).toBe(0);
    expect(zeroTimers.parsed?.SCHEDULER_INTERVAL_MS).toBe(0);
    expect(zeroTimers.parsed?.HEARTBEAT_MONITOR_INTERVAL_MS).toBe(0);
    expect(zeroTimers.parsed?.HEARTBEAT_TIMEOUT_SECONDS).toBe(0);
  });

  it.each([
    ['not-a-number', 'PORT'],
    ['0', 'PORT'],
    ['65536', 'PORT'],
  ])('rejects invalid PORT value %s', (value, issuePath) => {
    const result = loadConfiguration({ PORT: value });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(issuePath);
  });

  it('rejects invalid coercion and missing required values', () => {
    const invalidInterval = loadConfiguration({ SCHEDULER_INTERVAL_MS: 'not-a-number' });
    expect(invalidInterval.status).toBe(1);
    expect(invalidInterval.stderr).toContain('SCHEDULER_INTERVAL_MS');

    const missingDatabase = loadConfiguration({ DATABASE_URL: undefined });
    expect(missingDatabase.status).toBe(1);
    expect(missingDatabase.stderr).toContain('DATABASE_URL');

    const missingJwt = loadConfiguration({ JWT_SECRET: undefined });
    expect(missingJwt.status).toBe(1);
    expect(missingJwt.stderr).toContain('JWT_SECRET');
  });

  it('treats blank optional strings as absent', () => {
    const result = loadConfiguration({
      RESEND_API_KEY: '   ',
      EMAIL_FROM: '\t ',
      EMAIL_DELIVERY_ENCRYPTION_KEY: ' ',
    });

    expect(result.status).toBe(0);
    expect(result.parsed?.RESEND_API_KEY_CONFIGURED).toBe(false);
    expect(result.parsed?.EMAIL_FROM).toBeNull();
    expect(result.parsed?.EMAIL_DELIVERY_ENCRYPTION_KEY_CONFIGURED).toBe(false);
  });

  it('validates database and configured URL values', () => {
    expect(loadConfiguration({ DATABASE_URL: 'https://db.example.com' }).stderr)
      .toContain('DATABASE_URL');
    expect(loadConfiguration({ DATABASE_URL: 'not a URL' }).stderr)
      .toContain('DATABASE_URL');
    expect(loadConfiguration({ CORS_ORIGIN: 'not a URL' }).stderr)
      .toContain('CORS_ORIGIN');
    expect(loadConfiguration({ APP_BASE_URL: 'not a URL' }).stderr)
      .toContain('APP_BASE_URL');
    expect(loadConfiguration({ EMAIL_FROM: 'not-an-email' }).stderr)
      .toContain('EMAIL_FROM');

    const validUrls = loadConfiguration({
      DATABASE_URL: 'postgresql://db.example.com/app',
      CORS_ORIGIN: 'https://web.example.com',
      APP_BASE_URL: 'https://web.example.com',
    });
    expect(validUrls.status).toBe(0);
    expect(validUrls.parsed?.DATABASE_URL).toBe('postgresql://db.example.com/app');
  });

  it('normalizes blank optional email configuration and accepts valid configured values', () => {
    const key = 're_test_only_not_used_for_delivery';
    const encryptionKey = `${'A'.repeat(43)}=`;
    const configured = loadConfiguration({
      RESEND_API_KEY: key,
      EMAIL_FROM: ' Sender@Example.COM ',
      EMAIL_DELIVERY_ENCRYPTION_KEY: encryptionKey,
    });

    expect(configured.status).toBe(0);
    expect(configured.parsed?.EMAIL_FROM).toBe('Sender@Example.COM');
    expect(configured.parsed?.EMAIL_DELIVERY_ENCRYPTION_KEY_CONFIGURED).toBe(true);
    expect(configured.stdout).not.toContain(key);
    expect(configured.stdout).not.toContain(encryptionKey);
  });

  it('rejects the documented JWT placeholder in production without printing it', () => {
    const result = loadConfiguration({
      NODE_ENV: 'production',
      JWT_SECRET: knownTemplateSecret,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('JWT_SECRET');
    expect(result.stderr).toContain('unique production secret');
    expect(result.stderr).not.toContain(knownTemplateSecret);
  });

  it('rejects enabling the unscoped queue in production', () => {
    const result = loadConfiguration({
      NODE_ENV: 'production',
      JWT_SECRET: testJwtSecret,
      UNSCOPED_QUEUE_ENABLED: 'true',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('UNSCOPED_QUEUE_ENABLED');
    expect(result.stderr).toContain('must remain disabled in production');
  });

  it.each([
    [{ RESEND_API_KEY: 're_test_only_not_used_for_delivery' }, 'EMAIL_FROM'],
    [{ EMAIL_FROM: 'no-reply@example.com' }, 'RESEND_API_KEY'],
  ])('rejects partial email delivery configuration at %s', (configuration, issuePath) => {
    const result = loadConfiguration(configuration);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(issuePath);
    expect(result.stderr).toContain('Configure both RESEND_API_KEY and EMAIL_FROM');
    expect(result.stderr).not.toContain('re_test_only_not_used_for_delivery');
  });

  it('rejects a noncanonical email-delivery encryption key', () => {
    const result = loadConfiguration({ EMAIL_DELIVERY_ENCRYPTION_KEY: 'not-base64-key' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EMAIL_DELIVERY_ENCRYPTION_KEY');
    expect(result.stderr).toContain('canonical base64 for 32 random bytes');
  });

  it('requires token encryption when delivery is configured', () => {
    const result = loadConfiguration({
      RESEND_API_KEY: 're_test_only_not_used_for_delivery',
      EMAIL_FROM: 'no-reply@example.com',
      EMAIL_DELIVERY_ENCRYPTION_KEY: undefined,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('EMAIL_DELIVERY_ENCRYPTION_KEY');
    expect(result.stderr).toContain('protect queued verification tokens');
  });

  it('requires complete email delivery configuration in production', () => {
    const missing = loadConfiguration({
      NODE_ENV: 'production',
      JWT_SECRET: testJwtSecret,
    });

    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('RESEND_API_KEY');
    expect(missing.stderr).toContain('Configure RESEND_API_KEY and EMAIL_FROM in production');

    const httpUrl = loadConfiguration({
      NODE_ENV: 'production',
      JWT_SECRET: testJwtSecret,
      RESEND_API_KEY: 're_test_only_not_used_for_delivery',
      EMAIL_FROM: 'no-reply@example.com',
      EMAIL_DELIVERY_ENCRYPTION_KEY: `${'A'.repeat(43)}=`,
      APP_BASE_URL: 'http://app.example.com',
    });
    expect(httpUrl.status).toBe(1);
    expect(httpUrl.stderr).toContain('APP_BASE_URL');
    expect(httpUrl.stderr).toContain('must use HTTPS in production');

    const secure = loadConfiguration({
      NODE_ENV: 'production',
      JWT_SECRET: testJwtSecret,
      RESEND_API_KEY: 're_test_only_not_used_for_delivery',
      EMAIL_FROM: 'no-reply@example.com',
      EMAIL_DELIVERY_ENCRYPTION_KEY: `${'A'.repeat(43)}=`,
      APP_BASE_URL: 'https://app.example.com',
    });
    expect(secure.status).toBe(0);
  });
});
