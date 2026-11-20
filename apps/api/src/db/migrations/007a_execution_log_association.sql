ALTER TABLE execution_logs
  ADD COLUMN execution_id UUID NULL,
  ADD CONSTRAINT execution_logs_execution_fk
    FOREIGN KEY (execution_id) REFERENCES job_executions(id) ON DELETE SET NULL;
