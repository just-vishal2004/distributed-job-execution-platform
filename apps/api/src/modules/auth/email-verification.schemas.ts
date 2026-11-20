import { z } from 'zod';

export const requestEmailVerificationSchema = z.object({
  email: z.string().email().max(255).transform((email) => email.toLowerCase().trim()),
}).strict();

const verificationTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{64}$/;

export const confirmEmailVerificationSchema = z.object({
  token: z.string().min(101).max(101).regex(verificationTokenPattern),
}).strict();
