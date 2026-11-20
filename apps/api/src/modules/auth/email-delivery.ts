import { Resend } from 'resend';
import { env } from '../../config/env';
import { logger } from '../../utils/logger';
import { verificationEmailContent } from './email-verification.email';

export type EmailDeliveryResult =
  | { ok: true }
  | { ok: false; reason: 'provider' | 'network'; retryable: boolean };

export type VerificationEmail = {
  recordId: string;
  recipient: string;
  rawToken: string;
};

export interface VerificationEmailDelivery {
  sendVerificationEmail(message: VerificationEmail, signal?: AbortSignal): Promise<EmailDeliveryResult>;
}

export type ResendEmailConfiguration = {
  apiKey: string;
  from: string;
  appBaseUrl: string;
};

export function createConfiguredResendEmailProvider(
  configuration: {
    apiKey: string | undefined;
    from: string | undefined;
    appBaseUrl: string;
  },
): VerificationEmailDelivery | null {
  if (!configuration.apiKey || !configuration.from) return null;
  return createResendEmailProvider({
    apiKey: configuration.apiKey,
    from: configuration.from,
    appBaseUrl: configuration.appBaseUrl,
  });
}

export function createResendEmailProvider(
  configuration: ResendEmailConfiguration,
): VerificationEmailDelivery {
  return {
    async sendVerificationEmail(message, signal): Promise<EmailDeliveryResult> {
      try {
        const resend = new Resend(configuration.apiKey);
        const verificationUrl = new URL('/verify-email', configuration.appBaseUrl);
        verificationUrl.hash = `token=${encodeURIComponent(message.rawToken)}`;
        const content = verificationEmailContent(verificationUrl.toString());
        const requestOptions = signal
          ? { idempotencyKey: `email-verification/${message.recordId}`, signal }
          : { idempotencyKey: `email-verification/${message.recordId}` };
        const { error } = await resend.emails.send(
          {
            from: configuration.from,
            to: [message.recipient],
            subject: 'Verify your email address',
            text: content.text,
            html: content.html,
          },
          requestOptions,
        );

        if (error) {
          logger.warn('Verification email delivery failed', {
            event: 'email_delivery_failed',
            provider: 'resend',
            operation: 'email_verification',
            failureKind: 'provider',
            statusCode: error.statusCode,
          });
          const statusCode = typeof error.statusCode === 'number' ? error.statusCode : null;
          return {
            ok: false,
            reason: 'provider',
            retryable: statusCode === null || statusCode === 429 || statusCode >= 500,
          };
        }

        return { ok: true };
      } catch {
        logger.warn('Verification email delivery failed', {
          event: 'email_delivery_failed',
          provider: 'resend',
          operation: 'email_verification',
          failureKind: 'network',
        });
        return { ok: false, reason: 'network', retryable: true };
      }
    },
  };
}

export const verificationEmailDelivery = createConfiguredResendEmailProvider({
  apiKey: env.RESEND_API_KEY,
  from: env.EMAIL_FROM,
  appBaseUrl: env.APP_BASE_URL,
});
