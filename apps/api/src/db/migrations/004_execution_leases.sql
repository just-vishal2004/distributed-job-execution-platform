-- max_retries counts retries after the initial attempt; retry_count stores retries consumed.
ALTER TABLE job_executions
  ADD COLUMN lease_token UUID NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN lease_expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE workers ADD COLUMN credential_hash TEXT NULL;

CREATE UNIQUE INDEX idx_job_executions_lease_token ON job_executions(lease_token);
CREATE UNIQUE INDEX idx_job_executions_one_active_per_job
  ON job_executions(job_id) WHERE status IN ('assigned', 'running');
CREATE UNIQUE INDEX idx_job_executions_one_active_per_worker
  ON job_executions(worker_id) WHERE status IN ('assigned', 'running');
CREATE INDEX idx_job_executions_expired_active
  ON job_executions(lease_expires_at)
  WHERE status IN ('assigned', 'running');

-- Existing active work cannot know its newly assigned lease token. Expire it so
-- the monitor records a timeout and schedules a safe retry after deployment.
