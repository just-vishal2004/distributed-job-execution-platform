export type UserRole = 'candidate' | 'employer' | 'admin';

export interface AuthenticatedUser {
  id: string;
  sessionId: string;
  role: UserRole;
}

export interface AuthUser {
  id: string;
  email: string;
  role: UserRole;
  name: string;
}

export type ProjectStatus = 'active' | 'archived';
export type ProjectRole = 'owner' | 'admin' | 'member';
export type FormerOwnerRole = 'admin' | 'member' | 'removed';

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ProjectMembership {
  id: string;
  projectId: string;
  userId: string;
  role: ProjectRole;
  createdAt: string;
  revokedAt: string | null;
}

export interface ProjectAccess {
  project: Project;
  membership: ProjectMembership;
}

export type BackgroundJobStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type WorkerStatus = 'idle' | 'busy' | 'revoking' | 'dead';

export type ExecutionStatus =
  | 'assigned'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

export type LogLevel = 'info' | 'warn' | 'error';

export interface BackgroundJob {
  id: string;
  name: string;
  payload: Record<string, unknown>;
  status: BackgroundJobStatus;
  priority: number;
  maxRetries: number;
  retryCount: number;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Worker {
  id: string;
  hostname: string;
  status: WorkerStatus;
  lastHeartbeat: string;
  registeredAt: string;
  metadata: Record<string, unknown>;
}

export interface JobExecution {
  id: string;
  jobId: string;
  workerId: string;
  attempt: number;
  status: ExecutionStatus;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
}

export interface ExecutionLog {
  id: string;
  jobId: string;
  workerId: string | null;
  executionId: string | null;
  level: LogLevel;
  message: string;
  createdAt: string;
}

export interface SubmitBackgroundJobRequest {
  name: string;
  payload: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  scheduledAt?: string;
}

export interface RegisterWorkerRequest {
  hostname: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerLeaseHeartbeatRequest {
  executionId: string;
  jobId: string;
  leaseToken: string;
}

export interface WorkerRevocationAcknowledgementRequest extends WorkerLeaseHeartbeatRequest {}

export interface WorkerHeartbeatResponse {
  state: 'idle' | 'active';
  worker: Worker;
}

// Backward compatibility aliases for existing worker code during transition
export type JobStatus = BackgroundJobStatus;
export type Job = BackgroundJob;
export type SubmitJobRequest = SubmitBackgroundJobRequest;
