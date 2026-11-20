CREATE TYPE project_status AS ENUM ('active', 'archived');
CREATE TYPE project_role AS ENUM ('owner', 'admin', 'member');
CREATE TYPE project_invitation_role AS ENUM ('admin', 'member');

CREATE TABLE projects (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                     VARCHAR(255) NOT NULL,
  status                   project_status NOT NULL DEFAULT 'active',
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at              TIMESTAMPTZ NULL,
  scheduler_last_served_at TIMESTAMPTZ NULL,

  CONSTRAINT projects_archive_timestamp_check CHECK (
    (status = 'active' AND archived_at IS NULL)
    OR (status = 'archived' AND archived_at IS NOT NULL)
  )
);

CREATE INDEX idx_projects_scheduler_fairness
  ON projects(status, scheduler_last_served_at, id);

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TABLE project_memberships (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL,
  user_id     UUID NOT NULL,
  role        project_role NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ NULL,

  CONSTRAINT project_memberships_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT project_memberships_user_fk
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX uq_project_memberships_active_user
  ON project_memberships(project_id, user_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_project_memberships_user_active
  ON project_memberships(user_id, project_id)
  WHERE revoked_at IS NULL;
CREATE INDEX idx_project_memberships_project_history
  ON project_memberships(project_id, user_id, created_at DESC);

CREATE TABLE project_invitations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID NOT NULL,
  email               TEXT NOT NULL,
  role                project_invitation_role NOT NULL,
  token_hash          TEXT NOT NULL,
  invited_by_user_id  UUID NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ NOT NULL,
  accepted_at         TIMESTAMPTZ NULL,
  accepted_by_user_id UUID NULL,
  revoked_at          TIMESTAMPTZ NULL,

  CONSTRAINT project_invitations_email_normalized_check
    CHECK (email = lower(email) AND email = btrim(email)),
  CONSTRAINT project_invitations_token_hash_format_check
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT project_invitations_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT project_invitations_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT,
  CONSTRAINT project_invitations_inviter_fk
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT project_invitations_acceptor_fk
    FOREIGN KEY (accepted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX uq_project_invitations_token_hash
  ON project_invitations(token_hash);
CREATE UNIQUE INDEX uq_project_invitations_pending_email
  ON project_invitations(project_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
CREATE INDEX idx_project_invitations_project_created
  ON project_invitations(project_id, created_at DESC);

ALTER TABLE background_jobs
  ADD COLUMN project_id UUID NULL,
  ADD CONSTRAINT background_jobs_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

ALTER TABLE workers
  ADD COLUMN project_id UUID NULL,
  ADD CONSTRAINT workers_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

ALTER TABLE job_executions
  ADD COLUMN project_id UUID NULL,
  ADD CONSTRAINT job_executions_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

ALTER TABLE execution_logs
  ADD COLUMN project_id UUID NULL,
  ADD CONSTRAINT execution_logs_project_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT;

CREATE INDEX idx_background_jobs_project_id ON background_jobs(project_id);
CREATE INDEX idx_workers_project_id ON workers(project_id);
CREATE INDEX idx_job_executions_project_id ON job_executions(project_id);
CREATE INDEX idx_execution_logs_project_id ON execution_logs(project_id);
