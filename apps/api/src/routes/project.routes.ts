import { Router, type Request, type Response, type NextFunction } from 'express';
import type { Project, ProjectAccess, ProjectMembership } from '@meridian/types';
import { requireAuth } from '../middleware/auth';
import * as ProjectService from '../services/project.service';
import {
  changeMembershipRoleSchema,
  createProjectSchema,
  membershipParamsSchema,
  projectIdParamsSchema,
  transferOwnershipSchema,
} from './project.schemas';

const router = Router();
router.use(requireAuth);

function projectResponse(project: Project) {
  return {
    id: project.id,
    name: project.name,
    status: project.status,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    archivedAt: project.archivedAt,
  };
}

function membershipResponse(membership: ProjectMembership) {
  return {
    id: membership.id,
    projectId: membership.projectId,
    userId: membership.userId,
    role: membership.role,
    createdAt: membership.createdAt,
    revokedAt: membership.revokedAt,
  };
}

function projectAccessResponse(access: ProjectAccess) {
  return {
    project: projectResponse(access.project),
    membership: membershipResponse(access.membership),
  };
}

// POST /api/projects
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const input = createProjectSchema.parse(req.body);
    const access = await ProjectService.createProject(input.name, req.user!.id);
    res.status(201).json({ data: projectAccessResponse(access) });
  } catch (error) {
    next(error);
  }
});

// GET /api/projects
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projects = await ProjectService.listProjectsForUser(req.user!.id);
    res.json({ data: { projects: projects.map(projectAccessResponse) } });
  } catch (error) {
    next(error);
  }
});

// GET /api/projects/:projectId
router.get('/:projectId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = projectIdParamsSchema.parse(req.params);
    const access = await ProjectService.getProjectForUser(projectId, req.user!.id);
    res.json({ data: projectAccessResponse(access) });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/projects/:projectId/members/:userId
router.patch('/:projectId/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId, userId } = membershipParamsSchema.parse(req.params);
    const input = changeMembershipRoleSchema.parse(req.body);
    const membership = await ProjectService.changeMembershipRole(
      projectId,
      req.user!.id,
      userId,
      input.role,
    );
    res.json({ data: { membership: membershipResponse(membership) } });
  } catch (error) {
    next(error);
  }
});

// POST /api/projects/:projectId/ownership-transfer
router.post('/:projectId/ownership-transfer', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId } = projectIdParamsSchema.parse(req.params);
    const input = transferOwnershipSchema.parse(req.body);
    const result = await ProjectService.transferProjectOwnership(
      projectId,
      req.user!.id,
      input.recipientUserId,
      input.formerOwnerRole,
    );
    res.json({
      data: {
        formerOwner: membershipResponse(result.formerOwner),
        newOwner: membershipResponse(result.newOwner),
      },
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/projects/:projectId/members/:userId
router.delete('/:projectId/members/:userId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { projectId, userId } = membershipParamsSchema.parse(req.params);
    const membership = await ProjectService.revokeMembership(projectId, req.user!.id, userId);
    res.json({ data: { membership: membershipResponse(membership) } });
  } catch (error) {
    next(error);
  }
});

export default router;
