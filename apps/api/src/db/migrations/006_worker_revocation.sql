ALTER TYPE worker_status ADD VALUE IF NOT EXISTS 'revoking';

ALTER TABLE job_executions
  ADD COLUMN revocation_acknowledged_at TIMESTAMPTZ NULL;

CREATE INDEX idx_job_executions_unacknowledged_revocations
  ON job_executions(worker_id, id)
  WHERE status IN ('cancelled', 'timed_out')
    AND revocation_acknowledged_at IS NULL;
