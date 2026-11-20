import { z } from 'zod';

export const projectIdParamsSchema = z.object({
  projectId: z.string().uuid(),
});

export const membershipParamsSchema = projectIdParamsSchema.extend({
  userId: z.string().uuid(),
});

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(255),
}).strict();

export const changeMembershipRoleSchema = z.object({
  role: z.enum(['admin', 'member']),
}).strict();

export const transferOwnershipSchema = z.object({
  recipientUserId: z.string().uuid(),
  formerOwnerRole: z.enum(['admin', 'member', 'removed']),
}).strict();
