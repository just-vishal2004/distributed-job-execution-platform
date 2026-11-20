import type { PoolClient } from 'pg';
import type {
  FormerOwnerRole,
  Project,
  ProjectAccess,
  ProjectMembership,
  ProjectRole,
  ProjectStatus,
} from '@meridian/types';
import { pool } from '../db/pool';
import { AppError, conflict, forbidden, notFound } from '../utils/errors';

type ProjectRow = {
  id: string;
  name: string;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
};

type MembershipRow = {
  id: string;
  project_id: string;
  user_id: string;
  role: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
};

type LockedMembershipRow = {
  id: string;
  user_id: string;
  role: string;
  revoked_at: Date | string | null;
};

function dateValue(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableDateValue(value: Date | string | null): string | null {
  return value === null ? null : dateValue(value);
}

function projectRole(value: string): ProjectRole {
  if (value === 'owner' || value === 'admin' || value === 'member') return value;
  throw new Error(`Unexpected project role: ${value}`);
}

function projectStatus(value: string): ProjectStatus {
  if (value === 'active' || value === 'archived') return value;
  throw new Error(`Unexpected project status: ${value}`);
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    status: projectStatus(row.status),
    createdAt: dateValue(row.created_at),
    updatedAt: dateValue(row.updated_at),
    archivedAt: nullableDateValue(row.archived_at),
  };
}

function mapMembership(row: MembershipRow): ProjectMembership {
  return {
    id: row.id,
    projectId: row.project_id,
    userId: row.user_id,
    role: projectRole(row.role),
    createdAt: dateValue(row.created_at),
    revokedAt: nullableDateValue(row.revoked_at),
  };
}

function validateProjectName(name: string): string {
  const normalized = name.trim();
  if (normalized.length < 1 || normalized.length > 255) {
    throw new AppError('VALIDATION_ERROR', 'Project name must contain 1 to 255 characters', 400);
  }
  return normalized;
}

function validateFormerOwnerRole(role: FormerOwnerRole): void {
  if (role !== 'admin' && role !== 'member' && role !== 'removed') {
    throw new AppError('VALIDATION_ERROR', 'Former owner role must be admin, member, or removed', 400);
  }
}

function validateMembershipRole(role: ProjectRole): asserts role is 'admin' | 'member' {
  if (role !== 'admin' && role !== 'member') {
    throw new AppError('VALIDATION_ERROR', 'Use ownership transfer to assign the owner role', 400);
  }
}

async function rollback(client: PoolClient): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch {
    // Preserve the operation error if the connection has already failed.
  }
}

async function assertExactlyOneActiveOwner(client: PoolClient, projectId: string): Promise<void> {
  const { rows } = await client.query<{ owner_count: string | number }>(
    `SELECT count(*)::integer AS owner_count
     FROM project_memberships
     WHERE project_id = $1 AND role = 'owner' AND revoked_at IS NULL`,
    [projectId],
  );
  if (Number(rows[0]?.owner_count) !== 1) {
    throw conflict('A project must have exactly one active owner');
  }
}

async function lockUsers(client: PoolClient, userIds: string[]): Promise<Set<string>> {
  const orderedIds = [...new Set(userIds)].sort();
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM users
     WHERE id = ANY($1::uuid[])
     ORDER BY id
     FOR KEY SHARE`,
    [orderedIds],
  );
  return new Set(rows.map((row) => row.id));
}

async function lockMemberships(
  client: PoolClient,
  projectId: string,
  userIds: string[],
): Promise<LockedMembershipRow[]> {
  const orderedIds = [...new Set(userIds)].sort();
  const { rows } = await client.query<LockedMembershipRow>(
    `SELECT id, user_id, role, revoked_at
     FROM project_memberships
     WHERE project_id = $1 AND user_id = ANY($2::uuid[])
     ORDER BY user_id, id
     FOR UPDATE`,
    [projectId, orderedIds],
  );
  return rows;
}

function activeMembership(rows: LockedMembershipRow[], userId: string): LockedMembershipRow | undefined {
  return rows.find((row) => row.user_id === userId && row.revoked_at === null);
}

function requireActiveProject(row: ProjectRow | undefined): ProjectRow {
  if (!row) throw notFound('Project');
  if (row.status !== 'active') throw conflict('Archived projects are read-only');
  return row;
}

function requireActiveMembership(
  row: LockedMembershipRow | undefined,
  message = 'Project membership is required',
): LockedMembershipRow {
  if (!row || row.revoked_at !== null) throw notFound('Project');
  return row;
}

function requireOwner(row: LockedMembershipRow): void {
  if (row.role !== 'owner') throw forbidden('Only the project owner may perform this operation');
}

export async function createProject(name: string, actorUserId: string): Promise<ProjectAccess> {
  const normalizedName = validateProjectName(name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projects } = await client.query<ProjectRow>(
      `INSERT INTO projects (name)
       VALUES ($1)
       RETURNING id, name, status, created_at, updated_at, archived_at`,
      [normalizedName],
    );
    const projectRow = projects[0];
    if (!projectRow) throw new Error('Project insert returned no row');

    const lockedUsers = await lockUsers(client, [actorUserId]);
    if (!lockedUsers.has(actorUserId)) throw notFound('User');

    const { rows: memberships } = await client.query<MembershipRow>(
      `INSERT INTO project_memberships (project_id, user_id, role)
       VALUES ($1, $2, 'owner')
       RETURNING id, project_id, user_id, role, created_at, revoked_at`,
      [projectRow.id, actorUserId],
    );
    const membershipRow = memberships[0];
    if (!membershipRow) throw new Error('Owner membership insert returned no row');
    await assertExactlyOneActiveOwner(client, projectRow.id);
    await client.query('COMMIT');
    return { project: mapProject(projectRow), membership: mapMembership(membershipRow) };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function listProjectsForUser(actorUserId: string): Promise<ProjectAccess[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: candidateRows } = await client.query<{ project_id: string }>(
      `SELECT project_id
       FROM project_memberships
       WHERE user_id = $1 AND revoked_at IS NULL
       ORDER BY project_id`,
      [actorUserId],
    );
    const candidateIds = [...new Set(candidateRows.map((row) => row.project_id))].sort();
    if (candidateIds.length === 0) {
      await client.query('COMMIT');
      return [];
    }

    await client.query(
      `SELECT id FROM projects
       WHERE id = ANY($1::uuid[])
       ORDER BY id
       FOR SHARE`,
      [candidateIds],
    );
    const users = await lockUsers(client, [actorUserId]);
    if (!users.has(actorUserId)) throw notFound('User');
    const { rows: memberships } = await client.query<MembershipRow>(
      `SELECT id, project_id, user_id, role, created_at, revoked_at
       FROM project_memberships
       WHERE user_id = $1 AND project_id = ANY($2::uuid[]) AND revoked_at IS NULL
       ORDER BY project_id, id
       FOR SHARE`,
      [actorUserId, candidateIds],
    );
    if (memberships.length === 0) {
      await client.query('COMMIT');
      return [];
    }
    const membershipByProject = new Map(memberships.map((row) => [row.project_id, row]));
    const scopedProjectIds = memberships.map((row) => row.project_id);
    const { rows: projects } = await client.query<ProjectRow>(
      `SELECT id, name, status, created_at, updated_at, archived_at
       FROM projects
       WHERE id = ANY($1::uuid[])
       ORDER BY id`,
      [scopedProjectIds],
    );
    const results = projects.flatMap((projectRow) => {
      const membershipRow = membershipByProject.get(projectRow.id);
      return membershipRow
        ? [{ project: mapProject(projectRow), membership: mapMembership(membershipRow) }]
        : [];
    });
    await client.query('COMMIT');
    return results;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function getProjectForUser(projectId: string, actorUserId: string): Promise<ProjectAccess> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projects } = await client.query<ProjectRow>(
      `SELECT id, name, status, created_at, updated_at, archived_at
       FROM projects WHERE id = $1 FOR SHARE`,
      [projectId],
    );
    const projectRow = projects[0];
    if (!projectRow) throw notFound('Project');

    const users = await lockUsers(client, [actorUserId]);
    if (!users.has(actorUserId)) throw notFound('Project');
    const { rows: memberships } = await client.query<MembershipRow>(
      `SELECT id, project_id, user_id, role, created_at, revoked_at
       FROM project_memberships
       WHERE project_id = $1 AND user_id = $2 AND revoked_at IS NULL
       FOR SHARE`,
      [projectId, actorUserId],
    );
    const membershipRow = memberships[0];
    if (!membershipRow) throw notFound('Project');
    await client.query('COMMIT');
    return { project: mapProject(projectRow), membership: mapMembership(membershipRow) };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function changeMembershipRole(
  projectId: string,
  actorUserId: string,
  targetUserId: string,
  newRole: ProjectRole,
): Promise<ProjectMembership> {
  validateMembershipRole(newRole);
  if (actorUserId === targetUserId) throw conflict('Owners cannot change their own role');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projects } = await client.query<ProjectRow>(
      `SELECT id, name, status, created_at, updated_at, archived_at
       FROM projects WHERE id = $1 FOR UPDATE`,
      [projectId],
    );
    const projectRow = requireActiveProject(projects[0]);
    const users = await lockUsers(client, [actorUserId, targetUserId]);
    if (!users.has(actorUserId)) throw forbidden();
    if (!users.has(targetUserId)) throw notFound('User');
    const memberships = await lockMemberships(client, projectId, [actorUserId, targetUserId]);
    const actorMembership = requireActiveMembership(activeMembership(memberships, actorUserId));
    requireOwner(actorMembership);
    const targetMembership = activeMembership(memberships, targetUserId);
    if (!targetMembership) throw notFound('Project membership');
    if (targetMembership.role === 'owner') throw conflict('Use ownership transfer to change the project owner');

    let updatedMembership: MembershipRow;
    if (targetMembership.role === newRole) {
      const { rows } = await client.query<MembershipRow>(
        `SELECT id, project_id, user_id, role, created_at, revoked_at
         FROM project_memberships WHERE id = $1 AND revoked_at IS NULL`,
        [targetMembership.id],
      );
      if (rows.length !== 1 || rows[0].role !== newRole) {
        throw conflict('Membership changed during role update');
      }
      updatedMembership = rows[0];
    } else {
      const { rows } = await client.query<MembershipRow>(
        `UPDATE project_memberships SET role = $2
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id, project_id, user_id, role, created_at, revoked_at`,
        [targetMembership.id, newRole],
      );
      if (rows.length !== 1) throw conflict('Membership role update did not affect exactly one row');
      if (rows[0].role !== newRole) throw conflict('Membership role update returned an unexpected role');
      updatedMembership = rows[0];
    }
    await assertExactlyOneActiveOwner(client, projectRow.id);
    await client.query('COMMIT');
    return mapMembership(updatedMembership);
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function transferProjectOwnership(
  projectId: string,
  actorUserId: string,
  recipientUserId: string,
  formerOwnerRole: FormerOwnerRole,
): Promise<{ formerOwner: ProjectMembership; newOwner: ProjectMembership }> {
  validateFormerOwnerRole(formerOwnerRole);
  if (actorUserId === recipientUserId) throw conflict('The current owner is already the project owner');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projects } = await client.query<ProjectRow>(
      `SELECT id, name, status, created_at, updated_at, archived_at
       FROM projects WHERE id = $1 FOR UPDATE`,
      [projectId],
    );
    const projectRow = requireActiveProject(projects[0]);
    const users = await lockUsers(client, [actorUserId, recipientUserId]);
    if (!users.has(actorUserId)) throw forbidden();
    if (!users.has(recipientUserId)) throw notFound('User');
    const memberships = await lockMemberships(client, projectId, [actorUserId, recipientUserId]);
    const currentOwner = requireActiveMembership(activeMembership(memberships, actorUserId));
    requireOwner(currentOwner);
    const recipientMembership = activeMembership(memberships, recipientUserId);
    await assertExactlyOneActiveOwner(client, projectRow.id);

    let formerOwnerRow: MembershipRow;
    if (formerOwnerRole === 'removed') {
      const { rows } = await client.query<MembershipRow>(
        `UPDATE project_memberships SET revoked_at = clock_timestamp()
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id, project_id, user_id, role, created_at, revoked_at`,
        [currentOwner.id],
      );
      if (!rows[0]) throw conflict('The current owner membership changed during transfer');
      formerOwnerRow = rows[0];
    } else {
      const { rows } = await client.query<MembershipRow>(
        `UPDATE project_memberships SET role = $2
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id, project_id, user_id, role, created_at, revoked_at`,
        [currentOwner.id, formerOwnerRole],
      );
      if (!rows[0]) throw conflict('The current owner membership changed during transfer');
      formerOwnerRow = rows[0];
    }

    let newOwnerRow: MembershipRow | undefined;
    if (recipientMembership) {
      const { rows } = await client.query<MembershipRow>(
        `UPDATE project_memberships SET role = 'owner'
         WHERE id = $1 AND revoked_at IS NULL
         RETURNING id, project_id, user_id, role, created_at, revoked_at`,
        [recipientMembership.id],
      );
      newOwnerRow = rows[0];
    } else {
      const { rows } = await client.query<MembershipRow>(
        `INSERT INTO project_memberships (project_id, user_id, role)
         VALUES ($1, $2, 'owner')
         RETURNING id, project_id, user_id, role, created_at, revoked_at`,
        [projectId, recipientUserId],
      );
      newOwnerRow = rows[0];
    }
    if (!newOwnerRow) throw new Error('New owner membership was not written');
    await assertExactlyOneActiveOwner(client, projectRow.id);
    await client.query('COMMIT');
    return { formerOwner: mapMembership(formerOwnerRow), newOwner: mapMembership(newOwnerRow) };
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeMembership(
  projectId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<ProjectMembership> {
  if (actorUserId === targetUserId) throw forbidden('Self-revocation is unavailable');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: projects } = await client.query<ProjectRow>(
      `SELECT id, name, status, created_at, updated_at, archived_at
       FROM projects WHERE id = $1 FOR UPDATE`,
      [projectId],
    );
    const projectRow = requireActiveProject(projects[0]);
    const users = await lockUsers(client, [actorUserId, targetUserId]);
    if (!users.has(actorUserId)) throw forbidden();
    if (!users.has(targetUserId)) throw notFound('User');
    const memberships = await lockMemberships(client, projectId, [actorUserId, targetUserId]);
    const actorMembership = requireActiveMembership(activeMembership(memberships, actorUserId));
    const targetMembership = activeMembership(memberships, targetUserId);
    if (!targetMembership) throw notFound('Project membership');
    if (targetMembership.role === 'owner') {
      throw conflict('Transfer ownership before removing the project owner');
    }
    if (actorMembership.role === 'admin' && targetMembership.role !== 'member') {
      throw forbidden('Admins may manage member memberships only');
    }
    if (actorMembership.role !== 'owner' && actorMembership.role !== 'admin') {
      throw forbidden();
    }

    const { rows } = await client.query<MembershipRow>(
      `UPDATE project_memberships SET revoked_at = clock_timestamp()
       WHERE id = $1 AND revoked_at IS NULL
       RETURNING id, project_id, user_id, role, created_at, revoked_at`,
      [targetMembership.id],
    );
    if (!rows[0]) throw conflict('Membership changed during revocation');
    await assertExactlyOneActiveOwner(client, projectRow.id);
    await client.query('COMMIT');
    return mapMembership(rows[0]);
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}
