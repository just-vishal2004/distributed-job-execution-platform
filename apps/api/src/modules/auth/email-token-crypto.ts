import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../../config/env';

export type EncryptedEmailToken = {
  ciphertext: Buffer;
  nonce: Buffer;
  authTag: Buffer;
};

function encryptionKey(): Buffer {
  const configured = env.EMAIL_DELIVERY_ENCRYPTION_KEY;
  if (!configured) throw new Error('Email delivery encryption is not configured');
  const key = Buffer.from(configured, 'base64');
  if (key.length !== 32) throw new Error('Email delivery encryption key is invalid');
  return key;
}

export function encryptEmailToken(rawToken: string): EncryptedEmailToken {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  const ciphertext = Buffer.concat([cipher.update(rawToken, 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

export function decryptEmailToken(encrypted: EncryptedEmailToken): string {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), encrypted.nonce);
  decipher.setAuthTag(encrypted.authTag);
  return Buffer.concat([decipher.update(encrypted.ciphertext), decipher.final()]).toString('utf8');
}

export function encryptRequestedEmail(email: string): EncryptedEmailToken {
  return encryptEmailToken(email);
}

export function decryptRequestedEmail(encrypted: EncryptedEmailToken): string {
  return decryptEmailToken(encrypted);
}

export function emailEncryptionConfigured(): boolean {
  return env.EMAIL_DELIVERY_ENCRYPTION_KEY !== undefined;
}
