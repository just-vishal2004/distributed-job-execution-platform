-- Rename the background task table from jobs to background_jobs to eliminate
-- naming conflict with product job listings (employment opportunities).

DROP TRIGGER IF EXISTS jobs_updated_at ON jobs;

ALTER TABLE jobs RENAME TO background_jobs;

CREATE TRIGGER background_jobs_updated_at
  BEFORE UPDATE ON background_jobs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP INDEX IF EXISTS idx_jobs_scheduler;
CREATE INDEX idx_background_jobs_scheduler
  ON background_jobs(status, scheduled_at, priority DESC, created_at ASC);
