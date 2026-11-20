import { z } from 'zod';

const knownDevelopmentJwtPlaceholder =
  'change_me_to_a_secure_random_string_with_at_least_32_characters';
const optionalNonEmptyString = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().min(1).optional(),
);
const optionalEmail = z.preprocess(
  (value) => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().email().optional(),
);

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  PORT: z.coerce.number().int().min(1).max(65535).default(3001),

  DATABASE_URL: z.string().url().startsWith('postgresql'),

  // JWT signing secret: minimum 32 characters
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),

  // JWT expiry for session tokens
  JWT_EXPIRES_IN: z.string().default('7d'),

  // Allowed origin for CORS
  CORS_ORIGIN: z.string().url().default('http://localhost:3000'),

  RESEND_API_KEY: optionalNonEmptyString,
  EMAIL_FROM: optionalEmail,
  EMAIL_DELIVERY_ENCRYPTION_KEY: optionalNonEmptyString,
  APP_BASE_URL: z.string().url().default('http://localhost:3000'),

  // Scheduler and monitor intervals in milliseconds
  SCHEDULER_INTERVAL_MS: z.coerce.number().default(2000),
  HEARTBEAT_MONITOR_INTERVAL_MS: z.coerce.number().default(30000),
  HEARTBEAT_TIMEOUT_SECONDS: z.coerce.number().default(45),

  // Temporary compatibility switch for isolated local development only.
  UNSCOPED_QUEUE_ENABLED: z.enum(['true', 'false']).default('false'),

  LOG_LEVEL: z
    .enum(['error', 'warn', 'info', 'debug'])
    .default('info'),
}).superRefine((config, context) => {
  if (config.NODE_ENV === 'production' && config.JWT_SECRET === knownDevelopmentJwtPlaceholder) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['JWT_SECRET'],
      message: 'Set JWT_SECRET to a unique production secret',
    });
  }
  if (config.NODE_ENV === 'production' && config.UNSCOPED_QUEUE_ENABLED === 'true') {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['UNSCOPED_QUEUE_ENABLED'],
      message: 'Unscoped global queue assignment must remain disabled in production',
    });
  }
  const hasResendKey = config.RESEND_API_KEY !== undefined;
  const hasEmailFrom = config.EMAIL_FROM !== undefined;
  if (hasResendKey !== hasEmailFrom) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasResendKey ? 'EMAIL_FROM' : 'RESEND_API_KEY'],
      message: 'Configure both RESEND_API_KEY and EMAIL_FROM to enable email delivery',
    });
  }
  if (config.EMAIL_DELIVERY_ENCRYPTION_KEY !== undefined) {
    const key = config.EMAIL_DELIVERY_ENCRYPTION_KEY;
    const decoded = Buffer.from(key, 'base64');
    if (decoded.length !== 32 || decoded.toString('base64') !== key) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['EMAIL_DELIVERY_ENCRYPTION_KEY'],
        message: 'EMAIL_DELIVERY_ENCRYPTION_KEY must be canonical base64 for 32 random bytes',
      });
    }
  }
  if (hasResendKey && config.EMAIL_DELIVERY_ENCRYPTION_KEY === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['EMAIL_DELIVERY_ENCRYPTION_KEY'],
      message: 'Configure EMAIL_DELIVERY_ENCRYPTION_KEY to protect queued verification tokens',
    });
  }
  if (config.NODE_ENV === 'production') {
    if (!hasResendKey || !hasEmailFrom) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['RESEND_API_KEY'],
        message: 'Configure RESEND_API_KEY and EMAIL_FROM in production',
      });
    }
    if (new URL(config.APP_BASE_URL).protocol !== 'https:') {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['APP_BASE_URL'],
        message: 'APP_BASE_URL must use HTTPS in production',
      });
    }
  }
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    console.error(`\n[config] Invalid environment variables:\n${issues}\n`);
    process.exit(1);
  }

  return result.data;
}

export const env = validateEnv();
export type Env = typeof env;
