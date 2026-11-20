import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool';
import {
  changeMembershipRole,
  createProject,
  getProjectForUser,
  listProjectsForUser,
  revokeMembership,
  transferProjectOwnership,
} from '../services/project.service';

vi.mock('../db/pool', () => ({
  pool: { connect: vi.fn() },
}));

type MockMembership = {
  id: string;
  project_id: string;
  user_id: string;
  role: string;
  created_at: string;
  revoked_at: string | null;
};

type MockProject = {
  id: string;
  name: string;
  status: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
};

type MockState = {
  projects: MockProject[];
  users: Set<string>;
  memberships: MockMembership[];
  queries: string[];
  commits: number;
  rollbacks: number;
  failOn?: string;
  roleUpdateResult?: 'zero' | 'unexpected-role';
  ownerCountResponses?: number[];
};

const activeProject: MockProject = {
  id: 'project-1', name: 'Project One', status: 'active',
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', archived_at: null,
};

function membership(id: string, userId: string, role: string, revokedAt: string | null = null, projectId = 'project-1'): MockMembership {
  return {
    id, project_id: projectId, user_id: userId, role,
    created_at: '2026-01-01T00:00:00.000Z', revoked_at: revokedAt,
  };
}

function setupDatabase(initial?: Partial<MockState>) {
  const state: MockState = {
    projects: initial?.projects ?? [{ ...activeProject }],
    users: initial?.users ?? new Set(['owner', 'member', 'admin', 'other']),
    memberships: initial?.memberships ?? [membership('m-owner', 'owner', 'owner'), membership('m-member', 'member', 'member')],
    queries: [],
    commits: 0,
    rollbacks: 0,
    failOn: initial?.failOn,
    roleUpdateResult: initial?.roleUpdateResult,
    ownerCountResponses: initial?.ownerCountResponses,
  };
  let snapshot: { projects: MockProject[]; memberships: MockMembership[] } | null = null;

  const query = vi.fn(async (sqlText: string, values: unknown[] = []) => {
    const sql = sqlText.replace(/\s+/g, ' ').trim();
    const lower = sql.toLowerCase();
    state.queries.push(sql);

    if (state.failOn && lower.includes(state.failOn.toLowerCase())) {
      throw new Error('simulated database failure');
    }
    if (lower === 'begin') {
      snapshot = { projects: structuredClone(state.projects), memberships: structuredClone(state.memberships) };
      return { rows: [], rowCount: 0 };
    }
    if (lower === 'commit') {
      state.commits++;
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (lower === 'rollback') {
      state.rollbacks++;
      if (snapshot) {
        state.projects = snapshot.projects;
        state.memberships = snapshot.memberships;
      }
      snapshot = null;
      return { rows: [], rowCount: 0 };
    }
    if (lower.startsWith('insert into projects')) {
      const project: MockProject = {
        id: 'project-new', name: String(values[0]), status: 'active',
        created_at: '2026-02-01T00:00:00.000Z', updated_at: '2026-02-01T00:00:00.000Z', archived_at: null,
      };
      state.projects.push(project);
      return { rows: [{ ...project }], rowCount: 1 };
    }
    if (lower.startsWith('select project_id from project_memberships')) {
      const userId = String(values[0]);
      const ids = state.memberships.filter((row) => row.user_id === userId && row.revoked_at === null).map((row) => ({ project_id: row.project_id }));
      return { rows: ids, rowCount: ids.length };
    }
    if (lower.startsWith('select id from projects where id = any')) {
      const ids = values[0] as string[];
      const rows = state.projects.filter((row) => ids.includes(row.id)).map((row) => ({ id: row.id }));
      return { rows, rowCount: rows.length };
    }
    if (lower.startsWith('select id from users')) {
      const ids = values[0] as string[];
      const rows = [...state.users].filter((id) => ids.includes(id)).map((id) => ({ id }));
      return { rows, rowCount: rows.length };
    }
    if (lower.startsWith('select count(*)::integer as owner_count')) {
      const projectId = String(values[0]);
      const ownerCount = state.memberships.filter((row) => row.project_id === projectId && row.role === 'owner' && row.revoked_at === null).length;
      const expectedCount = state.ownerCountResponses?.shift() ?? ownerCount;
      return { rows: [{ owner_count: expectedCount }], rowCount: 1 };
    }
    if (lower.startsWith('select id, name, status, created_at, updated_at, archived_at from projects where id = $1')) {
      const project = state.projects.find((row) => row.id === values[0]);
      return { rows: project ? [{ ...project }] : [], rowCount: project ? 1 : 0 };
    }
    if (lower.startsWith('select id, name, status, created_at, updated_at, archived_at from projects where id = any')) {
      const ids = values[0] as string[];
      const rows = state.projects.filter((row) => ids.includes(row.id)).map((row) => ({ ...row }));
      return { rows, rowCount: rows.length };
    }
    if (lower.includes('from project_memberships') && lower.includes('where user_id = $1 and project_id = any')) {
      const [userId, projectIds] = values as [string, string[]];
      const rows = state.memberships.filter((row) => row.user_id === userId && projectIds.includes(row.project_id) && row.revoked_at === null).map((row) => ({ ...row }));
      return { rows, rowCount: rows.length };
    }
    if (lower.includes('from project_memberships') && lower.includes('where project_id = $1 and user_id = $2')) {
      const [projectId, userId] = values as [string, string];
      const rows = state.memberships.filter((row) => row.project_id === projectId && row.user_id === userId && row.revoked_at === null).map((row) => ({ ...row }));
      return { rows, rowCount: rows.length };
    }
    if (lower.startsWith('select id, user_id, role, revoked_at from project_memberships')) {
      const [projectId, userIds] = values as [string, string[]];
      const rows = state.memberships.filter((row) => row.project_id === projectId && userIds.includes(row.user_id)).map(({ id, user_id, role, revoked_at }) => ({ id, user_id, role, revoked_at }));
      return { rows, rowCount: rows.length };
    }
    if (lower.startsWith('insert into project_memberships')) {
      const [projectId, userId, role] = values as [string, string, string?];
      const row = membership(`m-${state.memberships.length + 1}`, userId, role ?? 'owner', null, projectId);
      state.memberships.push(row);
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith("update project_memberships set role = 'owner'")) {
      const id = String(values[0]);
      const row = state.memberships.find((item) => item.id === id && item.revoked_at === null);
      if (!row) return { rows: [], rowCount: 0 };
      row.role = 'owner';
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('update project_memberships set role =')) {
      const [id, role] = values as [string, string];
      const row = state.memberships.find((item) => item.id === id && item.revoked_at === null);
      if (!row) return { rows: [], rowCount: 0 };
      if (state.roleUpdateResult === 'zero') return { rows: [], rowCount: 0 };
      row.role = role;
      const resultRole = state.roleUpdateResult === 'unexpected-role' ? 'member' : role;
      return { rows: [{ ...row, role: resultRole }], rowCount: 1 };
    }
    if (lower.startsWith('update project_memberships set revoked_at =')) {
      const id = String(values[0]);
      const row = state.memberships.find((item) => item.id === id && item.revoked_at === null);
      if (!row) return { rows: [], rowCount: 0 };
      row.revoked_at = '2026-02-02T00:00:00.000Z';
      return { rows: [{ ...row }], rowCount: 1 };
    }
    if (lower.startsWith('select id, project_id, user_id, role, created_at, revoked_at from project_memberships where id = $1')) {
      const row = state.memberships.find((item) => item.id === values[0]);
      return { rows: row ? [{ ...row }] : [], rowCount: row ? 1 : 0 };
    }
    if (lower.startsWith('select p.id, p.name, p.status')) {
      const projectIds = values[0] as string[];
      const userId = String(values[1]);
      const rows = state.memberships.flatMap((member) => {
        const project = state.projects.find((item) => item.id === member.project_id);
        return member.user_id === userId && member.revoked_at === null && project && projectIds.includes(project.id)
          ? [{ ...project, membership_id: member.id, membership_project_id: member.project_id, membership_user_id: member.user_id, membership_role: member.role, membership_created_at: member.created_at, membership_revoked_at: member.revoked_at }]
          : [];
      });
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  });

  const client = { query, release: vi.fn() } as unknown as PoolClient;
  Object.defineProperty(pool, 'connect', {
    configurable: true,
    value: vi.fn().mockResolvedValue(client),
  });
  return { state, query };
}

describe('project and membership service foundation (mocked database)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a project and initial owner membership in one transaction', async () => {
    const { state, query } = setupDatabase({ projects: [], memberships: [] });
    const result = await createProject('  New project  ', 'owner');
    expect(result.project.name).toBe('New project');
    expect(result.membership.role).toBe('owner');
    expect(state.commits).toBe(1);
    expect(query.mock.calls[0][0]).toBe('BEGIN');
    expect(state.queries.findIndex((sql) => sql.includes('INSERT INTO projects'))).toBeLessThan(state.queries.findIndex((sql) => sql.includes('INSERT INTO project_memberships')));
    expect(state.queries.at(-1)).toBe('COMMIT');
  });

  it('lists only projects with an active membership, including archived projects as read-only records', async () => {
    const archived = { ...activeProject, id: 'project-2', name: 'Archived', status: 'archived', archived_at: '2026-01-02T00:00:00.000Z' };
    const { state } = setupDatabase({
      projects: [{ ...activeProject }, archived],
      memberships: [membership('m1', 'owner', 'owner'), membership('m2', 'owner', 'member', null, 'project-2'), membership('m3', 'owner', 'member', '2026-01-03T00:00:00.000Z', 'project-2')],
    });
    const projects = await listProjectsForUser('owner');
    expect(projects.map((item) => item.project.id)).toEqual(['project-1', 'project-2']);
    expect(projects[1].project.status).toBe('archived');
    expect(state.queries.some((sql) => sql.includes('revoked_at IS NULL'))).toBe(true);
  });

  it('rejects a non-member retrieving an existing project owned by another user', async () => {
    const otherProject = { ...activeProject, id: 'project-2', name: 'Other project' };
    setupDatabase({
      projects: [{ ...activeProject }, otherProject],
      memberships: [membership('m1', 'owner', 'owner', null, 'project-1'), membership('m2', 'other', 'owner', null, 'project-2')],
    });
    await expect(getProjectForUser('project-2', 'member')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('does not let a member change membership roles and performs no update', async () => {
    const { state } = setupDatabase({ memberships: [membership('m1', 'member', 'member'), membership('m2', 'other', 'member')] });
    await expect(changeMembershipRole('project-1', 'member', 'other', 'admin')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(state.queries.some((sql) => sql.startsWith('UPDATE project_memberships SET role'))).toBe(false);
  });

  it('returns the updated membership after a successful role transition', async () => {
    const { state } = setupDatabase();
    const result = await changeMembershipRole('project-1', 'owner', 'member', 'admin');
    expect(result.role).toBe('admin');
    expect(state.memberships.find((row) => row.id === 'm-member')?.role).toBe('admin');
    expect(state.commits).toBe(1);
    expect(state.rollbacks).toBe(0);
  });

  it('rolls back when the role UPDATE returns zero rows', async () => {
    const { state } = setupDatabase({ roleUpdateResult: 'zero' });
    await expect(changeMembershipRole('project-1', 'owner', 'member', 'admin'))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(state.memberships.find((row) => row.id === 'm-member')?.role).toBe('member');
    expect(state.commits).toBe(0);
    expect(state.rollbacks).toBe(1);
  });

  it('rolls back when the role UPDATE returns an unexpected role', async () => {
    const { state } = setupDatabase({ roleUpdateResult: 'unexpected-role' });
    await expect(changeMembershipRole('project-1', 'owner', 'member', 'admin'))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(state.memberships.find((row) => row.id === 'm-member')?.role).toBe('member');
    expect(state.commits).toBe(0);
    expect(state.rollbacks).toBe(1);
  });

  it('treats a request for the existing role as an idempotent no-op', async () => {
    const { state } = setupDatabase();
    const result = await changeMembershipRole('project-1', 'owner', 'member', 'member');
    expect(result.role).toBe('member');
    expect(state.queries.some((sql) => sql.startsWith('UPDATE project_memberships SET role'))).toBe(false);
    expect(state.commits).toBe(1);
    expect(state.rollbacks).toBe(0);
  });

  it('transfers ownership to an existing active member', async () => {
    const { state } = setupDatabase();
    const result = await transferProjectOwnership('project-1', 'owner', 'member', 'admin');
    expect(result.formerOwner.role).toBe('admin');
    expect(result.newOwner.role).toBe('owner');
    expect(state.memberships.filter((row) => row.role === 'owner' && row.revoked_at === null)).toHaveLength(1);
  });

  it('transfers ownership to an existing user who is not a project member', async () => {
    const { state } = setupDatabase({ memberships: [membership('m-owner', 'owner', 'owner')] });
    const result = await transferProjectOwnership('project-1', 'owner', 'other', 'member');
    expect(result.newOwner.userId).toBe('other');
    expect(state.memberships.find((row) => row.user_id === 'other')?.role).toBe('owner');
  });

  it.each([
    ['admin', 'admin', null],
    ['member', 'member', null],
    ['removed', 'owner', '2026-02-02T00:00:00.000Z'],
  ] as const)('preserves the requested former owner result: %s', async (formerRole, expectedRole, revokedAt) => {
    const { state } = setupDatabase({ memberships: [membership('m-owner', 'owner', 'owner')] });
    const result = await transferProjectOwnership('project-1', 'owner', 'other', formerRole);
    expect(result.formerOwner.role).toBe(expectedRole);
    expect(result.formerOwner.revokedAt === null).toBe(revokedAt === null);
    expect(state.memberships.filter((row) => row.role === 'owner' && row.revoked_at === null)).toHaveLength(1);
  });

  it('rolls back the entire transfer when establishing the new owner fails', async () => {
    const { state } = setupDatabase({
      memberships: [membership('m-owner', 'owner', 'owner'), membership('m-member', 'member', 'member')],
      failOn: "update project_memberships set role = 'owner'",
    });
    await expect(transferProjectOwnership('project-1', 'owner', 'member', 'removed')).rejects.toThrow('simulated database failure');
    expect(state.memberships.find((row) => row.user_id === 'owner')?.role).toBe('owner');
    expect(state.memberships.find((row) => row.user_id === 'owner')?.revoked_at).toBeNull();
    expect(state.commits).toBe(0);
    expect(state.rollbacks).toBe(1);
  });

  it('rejects ownership transfer on archived projects before changing memberships', async () => {
    const archived = { ...activeProject, status: 'archived', archived_at: '2026-01-02T00:00:00.000Z' };
    const { state } = setupDatabase({ projects: [archived] });
    await expect(transferProjectOwnership('project-1', 'owner', 'member', 'member')).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(state.queries.some((sql) => sql.startsWith('UPDATE project_memberships'))).toBe(false);
  });

  it('rolls back a transfer when the final active-owner check fails', async () => {
    const { state } = setupDatabase({
      memberships: [membership('m-owner', 'owner', 'owner'), membership('m-member', 'member', 'member')],
      ownerCountResponses: [1, 0],
    });
    await expect(transferProjectOwnership('project-1', 'owner', 'member', 'removed'))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(state.memberships.find((row) => row.id === 'm-owner')?.role).toBe('owner');
    expect(state.memberships.find((row) => row.id === 'm-owner')?.revoked_at).toBeNull();
    expect(state.memberships.find((row) => row.id === 'm-member')?.role).toBe('member');
    expect(state.commits).toBe(0);
    expect(state.rollbacks).toBe(1);
  });

  it('rejects the owner attempting to change or revoke their own membership', async () => {
    setupDatabase({ memberships: [membership('m-owner', 'owner', 'owner')] });
    await expect(changeMembershipRole('project-1', 'owner', 'owner', 'member')).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(revokeMembership('project-1', 'owner', 'owner')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('uses project-first lock ordering for membership mutations', async () => {
    const { state } = setupDatabase();
    await revokeMembership('project-1', 'owner', 'member');
    const projectLock = state.queries.findIndex((sql) => sql.includes('FROM projects WHERE id = $1 FOR UPDATE'));
    const userLock = state.queries.findIndex((sql) => sql.includes('FROM users'));
    const membershipLock = state.queries.findIndex((sql) => sql.includes('ORDER BY user_id, id FOR UPDATE'));
    expect(projectLock).toBeGreaterThan(-1);
    expect(projectLock).toBeLessThan(userLock);
    expect(userLock).toBeLessThan(membershipLock);
  });

  it('preserves revoked membership history when the revoked user receives ownership', async () => {
    const revokedAt = '2026-01-15T00:00:00.000Z';
    const { state } = setupDatabase({
      memberships: [membership('m-owner', 'owner', 'owner'), membership('m-old', 'other', 'member', revokedAt)],
    });
    const result = await transferProjectOwnership('project-1', 'owner', 'other', 'member');
    expect(state.memberships.find((row) => row.id === 'm-old')?.revoked_at).toBe(revokedAt);
    const activeRows = state.memberships.filter((row) => row.user_id === 'other' && row.revoked_at === null);
    expect(activeRows).toHaveLength(1);
    expect(activeRows[0].id).not.toBe('m-old');
    expect(activeRows[0].role).toBe('owner');
    expect(result.newOwner.id).toBe(activeRows[0].id);
  });

  it('allows admins to revoke members but not administer admin memberships', async () => {
    const { state } = setupDatabase({ memberships: [membership('m-owner', 'owner', 'owner'), membership('m-admin', 'admin', 'admin'), membership('m-member', 'member', 'member'), membership('m-other-admin', 'other', 'admin')] });
    await revokeMembership('project-1', 'admin', 'member');
    expect(state.memberships.find((row) => row.id === 'm-member')?.revoked_at).not.toBeNull();
    await expect(revokeMembership('project-1', 'admin', 'other')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('locks project before user and membership rows in competing owner operations (mocked ordering only)', async () => {
    const { state } = setupDatabase();
    await transferProjectOwnership('project-1', 'owner', 'member', 'member');
    const lockQueries = state.queries.filter((sql) => sql.includes('FOR UPDATE') || sql.includes('FOR KEY SHARE'));
    expect(lockQueries[0]).toContain('FROM projects');
    expect(lockQueries[1]).toContain('FROM users');
    expect(lockQueries[2]).toContain('FROM project_memberships');
  });
});
