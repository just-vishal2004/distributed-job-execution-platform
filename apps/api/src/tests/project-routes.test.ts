import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AppError } from '../utils/errors';
import { app } from '../index';
import { pool } from '../db/pool';
import { COOKIE_NAME, signToken } from '../utils/token';
import * as ProjectService from '../services/project.service';

vi.mock('../db/pool', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  connectDatabase: vi.fn(),
}));

vi.mock('../services/project.service', () => ({
  createProject: vi.fn(),
  listProjectsForUser: vi.fn(),
  getProjectForUser: vi.fn(),
  changeMembershipRole: vi.fn(),
  transferProjectOwnership: vi.fn(),
  revokeMembership: vi.fn(),
}));

const userId = '11111111-1111-4111-8111-111111111111';
const otherUserId = '22222222-2222-4222-8222-222222222222';
const projectId = '33333333-3333-4333-8333-333333333333';
const memberId = '44444444-4444-4444-8444-444444444444';
const membershipId = '55555555-5555-4555-8555-555555555555';

const projectAccess = {
  project: {
    id: projectId,
    name: 'Builds',
    status: 'active' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
  },
  membership: {
    id: membershipId,
    projectId,
    userId,
    role: 'owner' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    revokedAt: null,
  },
};

function cookieFor(user = userId): string {
  const token = signToken({ sub: user, jti: `session-${user}`, role: 'candidate' });
  return `${COOKIE_NAME}=${token}`;
}

function authenticate(): void {
  vi.mocked(pool.query).mockResolvedValue({
    rows: [{ user_id: userId, expires_at: new Date(Date.now() + 60_000) }],
  } as never);
}

describe('authenticated project routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it.each([
    ['create', () => request(app).post('/api/projects').send({ name: 'Builds' })],
    ['list', () => request(app).get('/api/projects')],
    ['detail', () => request(app).get(`/api/projects/${projectId}`)],
    ['change membership role', () => request(app).patch(`/api/projects/${projectId}/members/${memberId}`).send({ role: 'admin' })],
    ['transfer ownership', () => request(app).post(`/api/projects/${projectId}/ownership-transfer`).send({ recipientUserId: otherUserId, formerOwnerRole: 'member' })],
    ['revoke membership', () => request(app).delete(`/api/projects/${projectId}/members/${memberId}`)],
  ])('rejects unauthenticated %s requests', async (_name, sendRequest) => {
    const response = await sendRequest();
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('AUTHENTICATION_REQUIRED');
    expect(pool.query).not.toHaveBeenCalled();
    expect(ProjectService.createProject).not.toHaveBeenCalled();
    expect(ProjectService.listProjectsForUser).not.toHaveBeenCalled();
    expect(ProjectService.getProjectForUser).not.toHaveBeenCalled();
    expect(ProjectService.changeMembershipRole).not.toHaveBeenCalled();
    expect(ProjectService.transferProjectOwnership).not.toHaveBeenCalled();
    expect(ProjectService.revokeMembership).not.toHaveBeenCalled();
  });

  it('creates a project using the authenticated identity and returns only public fields', async () => {
    authenticate();
    vi.mocked(ProjectService.createProject).mockResolvedValue(projectAccess);

    const response = await request(app)
      .post('/api/projects')
      .set('Cookie', cookieFor())
      .send({ name: 'Builds' });

    expect(response.status).toBe(201);
    expect(ProjectService.createProject).toHaveBeenCalledWith('Builds', userId);
    expect(response.body).toEqual({ data: projectAccess });
    expect(JSON.stringify(response.body)).not.toMatch(/password|credential|lease_token|sql/i);
  });

  it('lists only the authenticated user scope and ignores caller identity query parameters', async () => {
    authenticate();
    vi.mocked(ProjectService.listProjectsForUser).mockResolvedValue([projectAccess]);

    const response = await request(app)
      .get('/api/projects')
      .query({ userId: otherUserId, actorUserId: otherUserId })
      .set('Cookie', cookieFor());

    expect(response.status).toBe(200);
    expect(ProjectService.listProjectsForUser).toHaveBeenCalledWith(userId);
    expect(response.body).toEqual({ data: { projects: [projectAccess] } });
  });

  it('maps cross-project detail denial from the service to a controlled 404', async () => {
    authenticate();
    vi.mocked(ProjectService.getProjectForUser).mockRejectedValue(new AppError('NOT_FOUND', 'Project not found', 404));

    const response = await request(app)
      .get(`/api/projects/${projectId}`)
      .set('Cookie', cookieFor());

    expect(response.status).toBe(404);
    expect(response.body.error).toEqual({ code: 'NOT_FOUND', message: 'Project not found' });
    expect(ProjectService.getProjectForUser).toHaveBeenCalledWith(projectId, userId);
  });

  it('passes role changes to the service with the authenticated actor', async () => {
    authenticate();
    vi.mocked(ProjectService.changeMembershipRole).mockResolvedValue({
      ...projectAccess.membership,
      userId: memberId,
      role: 'admin',
    });

    const response = await request(app)
      .patch(`/api/projects/${projectId}/members/${memberId}`)
      .set('Cookie', cookieFor())
      .send({ role: 'admin' });

    expect(response.status).toBe(200);
    expect(ProjectService.changeMembershipRole).toHaveBeenCalledWith(projectId, userId, memberId, 'admin');
    expect(response.body.data.membership.role).toBe('admin');
  });

  it('keeps membership authorization in the service for owner-only changes', async () => {
    authenticate();
    vi.mocked(ProjectService.changeMembershipRole).mockRejectedValue(new AppError('FORBIDDEN', 'Only the project owner may perform this operation', 403));

    const response = await request(app)
      .patch(`/api/projects/${projectId}/members/${memberId}`)
      .set('Cookie', cookieFor())
      .send({ role: 'member' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
    expect(ProjectService.changeMembershipRole).toHaveBeenCalledWith(projectId, userId, memberId, 'member');
  });

  it('passes admin revocation to the service and preserves service denials for admin targets', async () => {
    authenticate();
    vi.mocked(ProjectService.revokeMembership)
      .mockResolvedValueOnce({ ...projectAccess.membership, userId: memberId, role: 'member', revokedAt: '2026-01-02T00:00:00.000Z' })
      .mockRejectedValueOnce(new AppError('FORBIDDEN', 'Admins may manage member memberships only', 403));

    const memberResponse = await request(app)
      .delete(`/api/projects/${projectId}/members/${memberId}`)
      .set('Cookie', cookieFor());
    const adminResponse = await request(app)
      .delete(`/api/projects/${projectId}/members/${otherUserId}`)
      .set('Cookie', cookieFor());

    expect(memberResponse.status).toBe(200);
    expect(memberResponse.body.data.membership.revokedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(adminResponse.status).toBe(403);
    expect(ProjectService.revokeMembership).toHaveBeenNthCalledWith(1, projectId, userId, memberId);
    expect(ProjectService.revokeMembership).toHaveBeenNthCalledWith(2, projectId, userId, otherUserId);
  });

  it('returns the ownership transfer result and maps unauthorized transfers', async () => {
    authenticate();
    vi.mocked(ProjectService.transferProjectOwnership)
      .mockResolvedValueOnce({
        formerOwner: { ...projectAccess.membership, role: 'member' },
        newOwner: { ...projectAccess.membership, userId: otherUserId, role: 'owner' },
      })
      .mockRejectedValueOnce(new AppError('FORBIDDEN', 'Only the project owner may perform this operation', 403));

    const success = await request(app)
      .post(`/api/projects/${projectId}/ownership-transfer`)
      .set('Cookie', cookieFor())
      .send({ recipientUserId: otherUserId, formerOwnerRole: 'member' });
    const denied = await request(app)
      .post(`/api/projects/${projectId}/ownership-transfer`)
      .set('Cookie', cookieFor())
      .send({ recipientUserId: otherUserId, formerOwnerRole: 'member' });

    expect(success.status).toBe(200);
    expect(success.body.data.formerOwner.role).toBe('member');
    expect(success.body.data.newOwner.role).toBe('owner');
    expect(ProjectService.transferProjectOwnership).toHaveBeenNthCalledWith(1, projectId, userId, otherUserId, 'member');
    expect(denied.status).toBe(403);
  });

  it('rejects invalid UUIDs, malformed bodies, and attempts to supply actor identity', async () => {
    authenticate();
    const badId = await request(app).get('/api/projects/not-a-uuid').set('Cookie', cookieFor());
    const badName = await request(app).post('/api/projects').set('Cookie', cookieFor()).send({ name: '  ' });
    const ownerRole = await request(app).patch(`/api/projects/${projectId}/members/${memberId}`).set('Cookie', cookieFor()).send({ role: 'owner' });
    const identityOverride = await request(app).post('/api/projects').set('Cookie', cookieFor()).send({ name: 'Builds', actorUserId: otherUserId });
    const invalidTransfer = await request(app).post(`/api/projects/${projectId}/ownership-transfer`).set('Cookie', cookieFor()).send({ recipientUserId: 'bad-id', formerOwnerRole: 'member' });

    for (const response of [badId, badName, ownerRole, identityOverride, invalidTransfer]) {
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(ProjectService.getProjectForUser).not.toHaveBeenCalled();
    expect(ProjectService.createProject).not.toHaveBeenCalled();
    expect(ProjectService.changeMembershipRole).not.toHaveBeenCalled();
    expect(ProjectService.transferProjectOwnership).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with a controlled client error', async () => {
    const response = await request(app)
      .post('/api/projects')
      .set('Cookie', cookieFor())
      .set('Content-Type', 'application/json')
      .send('{"name":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(ProjectService.createProject).not.toHaveBeenCalled();
  });

  it('returns a safe generic response for unexpected database errors', async () => {
    authenticate();
    vi.mocked(ProjectService.createProject).mockRejectedValue(new Error('SELECT secret_column FROM internal_table failed'));

    const response = await request(app)
      .post('/api/projects')
      .set('Cookie', cookieFor())
      .send({ name: 'Builds' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' } });
    expect(JSON.stringify(response.body)).not.toContain('secret_column');
    expect(JSON.stringify(response.body)).not.toContain('internal_table');
  });
});
