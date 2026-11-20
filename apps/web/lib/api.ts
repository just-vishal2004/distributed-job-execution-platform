import type {
  AuthUser,
  BackgroundJob,
  JobExecution,
  ExecutionLog,
  Worker,
} from '@meridian/types';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface ApiErrorDetail {
  path?: string;
  message: string;
}

export class ApiError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: ApiErrorDetail[];

  constructor(
    code: string,
    message: string,
    statusCode: number,
    details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (!headers.has('Content-Type') && options?.body) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
    // Always include cookies so HTTP-only auth tokens are transmitted
    credentials: 'include',
  });

  if (!res.ok) {
    let errBody: { error?: { code?: string; message?: string; details?: ApiErrorDetail[] } } = {};
    try {
      errBody = await res.json();
    } catch {
      // Body not JSON
    }

    const code = errBody.error?.code ?? 'REQUEST_FAILED';
    const message = errBody.error?.message ?? `Request failed with status ${res.status}`;
    const details = errBody.error?.details;

    throw new ApiError(code, message, res.status, details);
  }

  return res.json();
}

export interface RegisterPayload {
  email: string;
  password: string;
  name: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export const api = {
  auth: {
    register: (payload: RegisterPayload) =>
      request<{ data: { user: AuthUser } }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),

    login: (payload: LoginPayload) =>
      request<{ data: { user: AuthUser } }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),

    logout: () =>
      request<{ data: { success: boolean } }>('/api/auth/logout', {
        method: 'POST',
      }),

    me: () => request<{ data: { user: AuthUser } }>('/api/auth/me'),

    requestEmailVerification: (email: string) =>
      request<{ data: { message: string } }>('/api/auth/email-verification/request', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),

    confirmEmailVerification: (token: string) =>
      request<{ data: { success: boolean; message: string } }>('/api/auth/email-verification/confirm', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
  },

  backgroundJobs: {
    list: (status?: string) =>
      request<{ jobs: BackgroundJob[]; count: number }>(
        status ? `/api/jobs?status=${encodeURIComponent(status)}` : '/api/jobs',
      ),

    get: (id: string) =>
      request<{
        backgroundJob: BackgroundJob;
        executions: JobExecution[];
        logs: ExecutionLog[];
      }>(`/api/jobs/${id}`),

    submit: (payload: {
      name: string;
      payload?: Record<string, unknown>;
      priority?: number;
      maxRetries?: number;
    }) =>
      request<{ job: BackgroundJob }>('/api/jobs', {
        method: 'POST',
        body: JSON.stringify(payload),
      }),

    cancel: (id: string) =>
      request<{ job: BackgroundJob }>(`/api/jobs/${id}`, {
        method: 'DELETE',
      }),
  },

  workers: {
    list: () => request<{ workers: Worker[]; count: number }>('/api/workers'),
  },
};
