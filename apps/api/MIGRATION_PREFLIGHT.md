# Migration 004 through 006 preflight and rollout

> Historical, phase-specific checklist for reviewing the rollout of migrations 004 through 006. This is not the current full-schema setup procedure. The current migration runner and readiness check require the complete canonical sequence through `007c_email_delivery_and_rate_limits.sql`. Use only a newly provisioned disposable database when following any migration command, and review the current migration set before deployment.

Do not run these migrations until the preflight and rollout steps are complete. These queries are read-only and should be run against the target database while the scheduler is stopped. The migration runner enforces PostgreSQL 12 or newer because migrations 005 and 006 add enum values inside the runner's transaction. API startup refuses to start its scheduler, recovery monitor, or listener unless the complete current migration sequence and required schema are present.

## Preflight queries

Find jobs with more than one active execution. Migration 004's job uniqueness index will fail if this returns rows:

```sql
SELECT job_id, COUNT(*) AS active_attempts, ARRAY_AGG(id ORDER BY id) AS execution_ids
FROM job_executions
WHERE status IN ('assigned', 'running')
GROUP BY job_id
HAVING COUNT(*) > 1
ORDER BY job_id;
```

Find workers with more than one active execution. Migration 004's worker uniqueness index will fail if this returns rows:

```sql
SELECT worker_id, COUNT(*) AS active_attempts, ARRAY_AGG(id ORDER BY id) AS execution_ids
FROM job_executions
WHERE status IN ('assigned', 'running')
GROUP BY worker_id
HAVING COUNT(*) > 1
ORDER BY worker_id;
```

List active attempts that the credential and lease rollout will invalidate. Existing worker processes do not possess the new per-attempt lease tokens:

```sql
SELECT je.id AS execution_id, je.job_id, je.worker_id, je.status,
       je.started_at, w.hostname, w.status AS worker_status
FROM job_executions je
JOIN workers w ON w.id = je.worker_id
WHERE je.status IN ('assigned', 'running')
ORDER BY je.job_id, je.id;
```

Find queued jobs that have no assigned or running execution. These rows may remain permanently queued after migration unless reconciled:

```sql
SELECT j.id, j.status, j.retry_count, j.max_retries
FROM background_jobs j
WHERE j.status = 'queued'
  AND NOT EXISTS (
    SELECT 1 FROM job_executions je
    WHERE je.job_id = j.id AND je.status IN ('assigned', 'running')
  )
ORDER BY j.id;
```

Find running jobs that have no assigned or running execution:

```sql
SELECT j.id, j.status, j.retry_count, j.max_retries
FROM background_jobs j
WHERE j.status = 'running'
  AND NOT EXISTS (
    SELECT 1 FROM job_executions je
    WHERE je.job_id = j.id AND je.status IN ('assigned', 'running')
  )
ORDER BY j.id;
```

Find busy workers that have no active attempt:

```sql
SELECT w.id, w.hostname, w.status, w.last_heartbeat
FROM workers w
WHERE w.status = 'busy'
  AND NOT EXISTS (
    SELECT 1 FROM job_executions je
    WHERE je.worker_id = w.id AND je.status IN ('assigned', 'running')
  )
ORDER BY w.id;
```

Find active attempts attached to terminal jobs. These may not block migration 004, but they contradict lifecycle state and require reconciliation before scheduling resumes:

```sql
SELECT je.id AS execution_id, je.job_id, je.worker_id, je.status AS execution_status,
       j.status AS job_status
FROM job_executions je
JOIN background_jobs j ON j.id = je.job_id
WHERE je.status IN ('assigned', 'running')
  AND j.status IN ('completed', 'failed', 'cancelled')
ORDER BY je.job_id, je.id;
```

Before migration 004, every existing worker needs to re-register because `credential_hash` does not exist yet and migration 004 adds it as NULL. Capture the worker inventory before the migration:

```sql
SELECT id, hostname, status, last_heartbeat
FROM workers
ORDER BY id;
```

After migration 004, verify which rows still need registration:

```sql
SELECT id, hostname, status
FROM workers
WHERE credential_hash IS NULL
ORDER BY id;
```

## Resolving inconsistent active rows

Take and verify a database backup before any manual reconciliation or data changes. Do not delete execution history. If any duplicate or inconsistent-state query returns data, keep scheduling stopped and inspect each listed attempt alongside execution logs and external task records. An operator must identify which work is still executing and which attempt is authoritative. After workers are stopped, use a reviewed transaction to mark only confirmed abandoned active attempts `timed_out`, set `finished_at` and a descriptive `error_message`, then reconcile the parent job (`pending` with a deliberately chosen retry count, or terminal `failed`) and worker state. Preserve every execution row. Re-run all preflight queries and confirm they return no rows before proceeding. Do not use a blanket update that chooses a canonical attempt without review.

## Deployment sequence

1. Stop accepting new work and stop the scheduler.
2. Drain workers where possible, then stop all old worker processes so they cannot continue external work.
3. Take and verify a database backup before any reconciliation.
4. Run all active-attempt, duplicate, and inconsistent-state queries above. Resolve inconsistent records explicitly and preserve history.
5. Re-run all preflight queries and confirm results are clear. Confirm the target reports `server_version_num >= 120000`:

   ```sql
   SELECT current_setting('server_version_num')::integer AS server_version_num;
   ```

6. Apply pending migrations 004, 005, and 006 in filename order using the migration runner. Do not run application code that writes `execution_status = 'cancelled'` until migration 005 commits, or code that writes worker status `revoking` until migration 006 commits.
7. Verify `schema_migrations` contains all applied filenames. Verify indexes `idx_job_executions_one_active_per_job`, `idx_job_executions_one_active_per_worker`, `idx_job_executions_expired_active`, and `idx_job_executions_unacknowledged_revocations` exist. Re-run the duplicate and state consistency queries.
8. Start new worker binaries and register them. Verify their `credential_hash` is non-NULL before scheduling.
9. Resume the scheduler and monitor lease recovery and worker registration.

The runner commits each migration and ledger entry separately. If 004 commits but 005 fails, keep scheduling stopped and do not run an application version that writes cancelled execution status. Confirm the server is PostgreSQL 12 or newer, inspect the 005 error, restore a backup or correct the cause under an approved procedure, then rerun the migration runner. Do not mark 005 applied manually. If 005 committed but 006 failed, do not run code that writes `revoking` or depends on the acknowledgement column; keep workers stopped and rerun the runner after correcting the cause. Migration failures roll back that migration's DDL and ledger insert, but do not roll back an earlier committed migration. Do not manually insert ledger rows. Migrations 005 and 006 are forward-only enum additions; do not remove enum labels as a routine rollback.

If the worker process cannot stop a task after revocation, it must not acknowledge the attempt. Keep that worker unavailable. A task promise settling does not prove detached asynchronous work or external operations stopped. A worker marked `dead` or deregistered is not evidence that external work ended. Lease expiry can make a retry eligible while an earlier external operation may still be running. Operators should confirm or isolate the old process, inspect the external system for side effects, and decide whether retry or manual reconciliation is safe. Use idempotency keys or external fencing for side effects that cannot overlap safely. Preserve execution rows and document the decision.

After confirming the process is stopped, an operator can retire the worker row with this reviewed statement:

```sql
UPDATE workers
SET status = 'dead'
WHERE id = :worker_id AND status IN ('revoking', 'busy')
RETURNING id, hostname, status;
```

Do not run this statement while the worker process may still be executing. `dead` workers are never scheduler candidates; register a new worker process after the old process has been isolated.
