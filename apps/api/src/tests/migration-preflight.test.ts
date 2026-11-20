import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('migration 004 through 006 preflight runbook', () => {
  it('includes read-only checks for duplicate active jobs, workers, invalidated work, and re-registration', () => {
    const runbook = fs.readFileSync(path.join(__dirname, '../../MIGRATION_PREFLIGHT.md'), 'utf8');
    expect(runbook).toContain('GROUP BY job_id');
    expect(runbook).toContain('GROUP BY worker_id');
    expect(runbook).toContain("je.status IN ('assigned', 'running')");
    expect(runbook).toContain('WHERE credential_hash IS NULL');
  });

  it('checks every lifecycle preflight query against the migrated schema names and statuses', () => {
    const root = path.join(__dirname, '../../src/db/migrations');
    const runbook = fs.readFileSync(path.join(__dirname, '../../MIGRATION_PREFLIGHT.md'), 'utf8');
    const initial = fs.readFileSync(path.join(root, '001_initial_schema.sql'), 'utf8');
    const rename = fs.readFileSync(path.join(root, '002_rename_background_jobs.sql'), 'utf8');
    const leases = fs.readFileSync(path.join(root, '004_execution_leases.sql'), 'utf8');
    const cancelled = fs.readFileSync(path.join(root, '005_cancelled_execution_status.sql'), 'utf8');

    expect(rename).toContain('ALTER TABLE jobs RENAME TO background_jobs');
    expect(initial).toContain('CREATE TABLE job_executions');
    expect(initial).toContain("'assigned', 'running', 'completed', 'failed', 'timed_out'");
    expect(cancelled).toContain("ADD VALUE IF NOT EXISTS 'cancelled'");
    expect(initial).toContain("'queued', 'running', 'completed', 'failed', 'cancelled'");
    expect(initial).toContain("'idle', 'busy', 'dead'");
    expect(leases).toContain('lease_expires_at');

    const queries = [
      /SELECT j\.id, j\.status, j\.retry_count, j\.max_retries[\s\S]*?WHERE j\.status = 'queued'[\s\S]*?je\.status IN \('assigned', 'running'\)/,
      /SELECT j\.id, j\.status, j\.retry_count, j\.max_retries[\s\S]*?WHERE j\.status = 'running'[\s\S]*?je\.status IN \('assigned', 'running'\)/,
      /SELECT w\.id, w\.hostname, w\.status, w\.last_heartbeat[\s\S]*?WHERE w\.status = 'busy'[\s\S]*?je\.status IN \('assigned', 'running'\)/,
      /SELECT je\.id AS execution_id[\s\S]*?j\.status IN \('completed', 'failed', 'cancelled'\)/,
    ];
    for (const query of queries) expect(runbook).toMatch(query);
    expect(runbook).toContain('FROM background_jobs j');
    expect(runbook).toContain('FROM job_executions je');
    expect(runbook).toContain('FROM workers w');
  });

  it('documents a preserve-history rollout and ordered migration process', () => {
    const runbook = fs.readFileSync(path.join(__dirname, '../../MIGRATION_PREFLIGHT.md'), 'utf8');
    expect(runbook).toContain('Do not delete execution history');
    expect(runbook).toContain('Apply pending migrations 004, 005, and 006 in filename order');
    expect(runbook).toContain('Take and verify a database backup');
  });
});
