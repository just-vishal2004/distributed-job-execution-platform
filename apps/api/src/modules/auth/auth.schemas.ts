import { z } from 'zod';

const PASSWORD_MIN_LENGTH = 8;

const passwordSchema = z
  .string()
  .min(
    PASSWORD_MIN_LENGTH,
    `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
  )
  .max(128, 'Password must not exceed 128 characters')
  .refine(
    (pw) => /[a-zA-Z]/.test(pw),
    'Password must contain at least one letter',
  )
  .refine((pw) => /[0-9]/.test(pw), 'Password must contain at least one number');

export const registerSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .max(255, 'Email is too long')
    .transform((e) => e.toLowerCase().trim()),
  password: passwordSchema,
  name: z
    .string()
    .min(1, 'Name is required')
    .max(100, 'Name is too long')
    .trim(),
  role: z.enum(['candidate', 'employer']).default('candidate'),
});

export const loginSchema = z.object({
  email: z
    .string()
    .email('Invalid email address')
    .transform((e) => e.toLowerCase().trim()),
  password: z.string().min(1, 'Password is required'),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
