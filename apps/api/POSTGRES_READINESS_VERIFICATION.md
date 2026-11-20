# PostgreSQL readiness verification

The repository has an opt-in PostgreSQL integration test for email verification, but no checked-in PostgreSQL integration suite for readiness catalog validation or general lifecycle concurrency, and no container provisioning setup. The readiness unit tests mock catalog rows and do not prove that catalog queries or PostgreSQL expression deparsing work against a server. Do not point this procedure at an existing or production database.

## Verify a clean migrated schema

Use a disposable PostgreSQL database with the same major version as the deployment target. The migration runner itself rejects versions below PostgreSQL 12.

```sh
createdb meridian_readiness_scratch
DATABASE_URL='postgresql://localhost/meridian_readiness_scratch' npm run migrate --workspace=apps/api
npm run build --workspace=apps/api
DATABASE_URL='postgresql://localhost/meridian_readiness_scratch' node -e "const { verifyDatabaseReadiness } = require('./apps/api/dist/apps/api/src/db/readiness.js'); const { pool } = require('./apps/api/dist/apps/api/src/db/pool.js'); verifyDatabaseReadiness().then(() => console.log('readiness passed')).catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());"
```

The readiness call should pass after all migrations complete. For a negative predicate check, recreate the scratch database, apply migrations there, then replace `idx_job_executions_one_active_per_worker` with this same-name index. It retains the expected table, column, uniqueness, and partial-index status while using the wrong predicate:

```sql
DROP INDEX idx_job_executions_one_active_per_worker;
CREATE UNIQUE INDEX idx_job_executions_one_active_per_worker
  ON job_executions(worker_id) WHERE status = 'failed';
```

Rerun the readiness command. It should reject the index predicate. Recreate the database between corruption cases so each check starts from the migration-defined schema.

Drop only the disposable database after verification:

```sh
dropdb meridian_readiness_scratch
```

These steps are a manual verification procedure, not evidence that PostgreSQL integration tests have run. No migrations were applied as part of the Phase 1F implementation.
