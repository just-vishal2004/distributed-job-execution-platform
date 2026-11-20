import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { runMigrations } from '../db/migrate';
import { MIGRATION_SEQUENCE } from '../db/migration-history';
import * as BackgroundJobService from '../services/background-job.service';
import { pool } from '../db/pool';
import type { Pool } from 'pg';

vi.mock('../db/pool', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));

describe('Database Migrations and Background Worker System', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Migration Pipeline', () => {
    it('discovers and executes migrations in numerical order', async () => {
      const migrationsDir = path.join(__dirname, '../db/migrations');
      const files = fs
        .readdirSync(migrationsDir)
        .filter((f) => f.endsWith('.sql'))
        .sort();

      expect(files).toEqual([
        '001_initial_schema.sql',
        '002_rename_background_jobs.sql',
        '003_auth.sql',
        '004_execution_leases.sql',
        '005_cancelled_execution_status.sql',
        '006_worker_revocation.sql',
        '007_project_foundation.sql',
        '007a_execution_log_association.sql',
        '007b_email_verification_tokens.sql',
        '007c_email_delivery_and_rate_limits.sql',
      ]);
      expect(files).toEqual(MIGRATION_SEQUENCE);

      // Mock pool to simulate running migrations
      const mockClient = {
        query: vi.fn().mockResolvedValue({}),
        release: vi.fn(),
      };

      const mockPool = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [{ server_version_num: 120000 }] }) // PostgreSQL version check
          .mockResolvedValueOnce({}) // CREATE TABLE schema_migrations
          .mockResolvedValueOnce({ rows: [] }), // empty migration ledger
        connect: vi.fn().mockResolvedValue(mockClient),
        end: vi.fn().mockResolvedValue({}),
      } as unknown as Pool;

      const applied = await runMigrations(mockPool);
      expect(applied).toEqual([
        '001_initial_schema.sql',
        '002_rename_background_jobs.sql',
        '003_auth.sql',
        '004_execution_leases.sql',
        '005_cancelled_execution_status.sql',
        '006_worker_revocation.sql',
        '007_project_foundation.sql',
        '007a_execution_log_association.sql',
        '007b_email_verification_tokens.sql',
        '007c_email_delivery_and_rate_limits.sql',
      ]);

      // Verify each migration is recorded in schema_migrations
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        ['001_initial_schema.sql'],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        ['002_rename_background_jobs.sql'],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        ['003_auth.sql'],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        ['004_execution_leases.sql'],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        ['005_cancelled_execution_status.sql'],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        ['006_worker_revocation.sql'],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        ['007_project_foundation.sql'],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        ['007a_execution_log_association.sql'],
      );
      expect(mockClient.query).toHaveBeenCalledWith(
        'INSERT INTO schema_migrations (filename) VALUES ($1)',
        ['007b_email_verification_tokens.sql'],
      );
    });

    it('rejects PostgreSQL versions below 12 before touching the migration ledger', async () => {
      const mockPool = {
        query: vi.fn().mockResolvedValue({ rows: [{ server_version_num: 110000 }] }),
        connect: vi.fn(),
        end: vi.fn(),
      } as unknown as Pool;
      await expect(runMigrations(mockPool)).rejects.toThrow('PostgreSQL 12 or newer is required');
      expect(mockPool.query).toHaveBeenCalledTimes(1);
      expect(mockPool.connect).not.toHaveBeenCalled();
    });

    it('refuses to apply a newly introduced predecessor after a later migration is recorded', async () => {
      const migrationTimes = MIGRATION_SEQUENCE.slice(0, 9)
        .filter((filename) => filename !== '007a_execution_log_association.sql')
        .map((filename, index) => ({ filename, applied_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)) }));
      const mockPool = {
        query: vi.fn()
          .mockResolvedValueOnce({ rows: [{ server_version_num: 160000 }] })
          .mockResolvedValueOnce({})
          .mockResolvedValueOnce({ rows: migrationTimes }),
        connect: vi.fn(),
        end: vi.fn(),
      } as unknown as Pool;
      await expect(runMigrations(mockPool)).rejects.toThrow('missing predecessor migrations before an applied later migration: 007a_execution_log_association.sql');
      expect(mockPool.connect).not.toHaveBeenCalled();
    });

    it('validates that 002_rename_background_jobs.sql renames jobs table correctly', () => {
      const sql = fs.readFileSync(
        path.join(__dirname, '../db/migrations/002_rename_background_jobs.sql'),
        'utf-8',
      );

      expect(sql).toContain('ALTER TABLE jobs RENAME TO background_jobs;');
      expect(sql).toContain('CREATE TRIGGER background_jobs_updated_at');
      expect(sql).toContain('idx_background_jobs_scheduler');
    });

    it('validates that 003_auth.sql defines users, sessions, and profiles schemas', () => {
      const sql = fs.readFileSync(
        path.join(__dirname, '../db/migrations/003_auth.sql'),
        'utf-8',
      );

      expect(sql).toContain("CREATE TYPE user_role AS ENUM ('candidate', 'employer', 'admin');");
      expect(sql).toContain('CREATE TABLE users');
      expect(sql).toContain('CREATE TABLE sessions');
      expect(sql).toContain('CREATE TABLE profiles');
      expect(sql).toContain('idx_sessions_lookup');
    });

    it('adds cancelled as a forward-only execution status', () => {
      const sql = fs.readFileSync(
        path.join(__dirname, '../db/migrations/005_cancelled_execution_status.sql'),
        'utf-8',
      );
      expect(sql).toContain("ALTER TYPE execution_status ADD VALUE IF NOT EXISTS 'cancelled';");
    });

    it('adds an explicit revoking worker state and acknowledgement ledger', () => {
      const sql = fs.readFileSync(
        path.join(__dirname, '../db/migrations/006_worker_revocation.sql'),
        'utf-8',
      );
      expect(sql).toContain("ALTER TYPE worker_status ADD VALUE IF NOT EXISTS 'revoking';");
      expect(sql).toContain('ADD COLUMN revocation_acknowledged_at TIMESTAMPTZ NULL');
      expect(sql).toContain('idx_job_executions_unacknowledged_revocations');
    });

    it('defines the project foundation without assigning existing resources', () => {
      const sql = fs.readFileSync(
        path.join(__dirname, '../db/migrations/007_project_foundation.sql'),
        'utf-8',
      );
      const leases = fs.readFileSync(
        path.join(__dirname, '../db/migrations/004_execution_leases.sql'),
        'utf-8',
      );

      expect(sql).toContain('CREATE TABLE projects');
      expect(sql).toContain('scheduler_last_served_at TIMESTAMPTZ NULL');
      expect(sql).toContain('CREATE TABLE project_memberships');
      expect(sql).toContain("CREATE TYPE project_role AS ENUM ('owner', 'admin', 'member')");
      expect(sql).toContain('uq_project_memberships_active_user');
      expect(sql).toContain('CREATE TABLE project_invitations');
      expect(sql).toContain('uq_project_invitations_pending_email');
      expect(sql).toContain('accepted_at IS NULL AND revoked_at IS NULL');
      expect(sql).not.toMatch(/expires_at\s*>\s*(?:NOW\(|clock_timestamp\()/i);
      expect(sql).toContain('token_hash');
      expect(sql).not.toMatch(/\btoken\s+TEXT\b/i);

      for (const table of ['background_jobs', 'workers', 'job_executions', 'execution_logs']) {
        expect(sql).toMatch(new RegExp(`ALTER TABLE ${table}[\\s\\S]*?ADD COLUMN project_id UUID NULL`));
        expect(sql).toMatch(new RegExp(`ALTER TABLE ${table}[\\s\\S]*?ON DELETE RESTRICT`));
      }

      expect(sql).not.toMatch(/UPDATE\s+(?:background_jobs|workers|job_executions|execution_logs)/i);
      expect(sql).not.toMatch(/\bproject_id\s+UUID\s+NOT NULL\s+DEFAULT\b/i);
      expect(sql).not.toMatch(/DROP\s+INDEX/i);
      expect(sql).not.toContain('idx_job_executions_one_active_per_job');
      expect(sql).not.toContain('idx_job_executions_one_active_per_worker');
      expect(leases).toContain('CREATE UNIQUE INDEX idx_job_executions_one_active_per_job');
      expect(leases).toContain('CREATE UNIQUE INDEX idx_job_executions_one_active_per_worker');
    });

    it('adds a nullable execution association without backfilling historical logs', () => {
      const sql = fs.readFileSync(
        path.join(__dirname, '../db/migrations/007a_execution_log_association.sql'),
        'utf-8',
      );

      expect(sql).toContain('ADD COLUMN execution_id UUID NULL');
      expect(sql).toContain('FOREIGN KEY (execution_id) REFERENCES job_executions(id) ON DELETE SET NULL');
      expect(sql).not.toMatch(/execution_id\s+UUID\s+NOT NULL/i);
      expect(sql).not.toMatch(/execution_id\s+UUID\s+[^,;]*DEFAULT/i);
      expect(sql).not.toMatch(/\bUPDATE\s+execution_logs\b/i);
      expect(sql).not.toMatch(/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i);
    });

    it('adds an encrypted email request and delivery queue with a shared rate-limit table', () => {
      const sql = fs.readFileSync(
        path.join(__dirname, '../db/migrations/007c_email_delivery_and_rate_limits.sql'),
        'utf-8',
      );
      expect(sql).toContain('CREATE TABLE email_verification_requests');
      expect(sql).toContain('CREATE TABLE email_verification_deliveries');
      expect(sql).toContain('CREATE TABLE email_verification_rate_limits');
      expect(sql).toContain('verification_token_id UUID NOT NULL UNIQUE');
      expect(sql).toContain('REFERENCES email_verification_tokens(id) ON DELETE CASCADE');
      expect(sql).not.toMatch(/raw_token\s+TEXT|recipient\s+TEXT|email\s+TEXT/i);
      expect(sql).toContain('idx_email_verification_deliveries_pending');
      expect(sql).toContain('idx_email_verification_rate_limits_expiry');
    });

    it('adds one-time email verification token storage without storing raw tokens', () => {
      const sql = fs.readFileSync(
        path.join(__dirname, '../db/migrations/007b_email_verification_tokens.sql'),
        'utf-8',
      );

      expect(sql).toContain('CREATE TABLE email_verification_tokens');
      expect(sql).toContain('FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');
      expect(sql).toContain("CHECK (token_hash ~ '^[0-9a-f]{64}$')");
      expect(sql).toContain('CHECK (expires_at > created_at)');
      expect(sql).toContain('CHECK (consumed_at IS NULL OR revoked_at IS NULL)');
      expect(sql).toContain('uq_email_verification_tokens_hash');
      expect(sql).toContain('uq_email_verification_tokens_outstanding_user_email');
      expect(sql).not.toMatch(/\braw_token\b|\bverification_url\b/i);
    });
  });

  describe('Background Worker Service Integration with background_jobs', () => {
    it('creates background jobs targeting the background_jobs table', async () => {
      const mockJobRow = {
        id: 'job-123',
        name: 'resume.process',
        payload: { resumeId: 'res-456' },
        status: 'pending',
        priority: 7,
        max_retries: 3,
        retry_count: 0,
        scheduled_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      (pool.query as any).mockResolvedValueOnce({ rows: [mockJobRow] });

      const created = await BackgroundJobService.createBackgroundJob({
        name: 'resume.process',
        payload: { resumeId: 'res-456' },
        priority: 7,
      });

      expect(created.id).toBe('job-123');
      expect(created.name).toBe('resume.process');
      expect(created.status).toBe('pending');
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO background_jobs'),
        expect.arrayContaining(['resume.process', { resumeId: 'res-456' }, 7, 3, null]),
      );
    });

    it('cancels background jobs targeting the background_jobs table', async () => {
      const mockCancelledRow = {
        id: 'job-123',
        name: 'resume.process',
        payload: {},
        status: 'cancelled',
        priority: 5,
        max_retries: 3,
        retry_count: 0,
        scheduled_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      const mockClient = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT id, status FROM background_jobs')) return { rows: [{ id: mockCancelledRow.id, status: 'pending' }] };
          if (sql.includes('UPDATE background_jobs SET status =')) return { rows: [mockCancelledRow] };
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      (pool.connect as any).mockResolvedValueOnce(mockClient);

      const result = await BackgroundJobService.cancelBackgroundJob('job-123');

      expect(result).not.toBeNull();
      expect(result?.status).toBe('cancelled');
      expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
      expect(mockClient.release).toHaveBeenCalledOnce();
    });
  });
});
