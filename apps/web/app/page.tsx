'use client';

import React from 'react';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';

export default function HomePage() {
  const { user, loading, error, logout } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="text-sm text-[#a1a1aa]">Loading session...</div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center p-6">
        <div className="w-full max-w-md bg-[#111113] border border-[#27272a] rounded-lg p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight text-[#fafafa] mb-2">
            Meridian
          </h1>
          <p className="text-sm text-[#a1a1aa] mb-6">
            An engineering prototype for reliable background work, worker coordination, and execution recovery.
          </p>

          {error && (
            <div
              role="alert"
              className="mb-4 p-3 rounded bg-[#450a0a] border border-[#ef4444]/40 text-sm text-[#fca5a5]"
            >
              {error}
            </div>
          )}

          <div className="space-y-3">
            <Link
              href="/login"
              className="block w-full h-10 leading-10 rounded bg-[#6366f1] hover:bg-[#4f46e5] text-white text-sm font-medium transition-colors text-center"
            >
              Sign in
            </Link>
            <Link
              href="/register"
              className="block w-full h-10 leading-10 rounded bg-[#19191c] hover:bg-[#222226] border border-[#27272a] text-[#fafafa] text-sm font-medium transition-colors text-center"
            >
              Create account
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-[#27272a] bg-[#111113] px-6 py-3.5">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <span className="font-semibold text-base tracking-tight text-[#fafafa]">
            Meridian
          </span>

          <div className="flex items-center space-x-4">
            <div className="text-right">
              <div className="text-xs font-medium text-[#fafafa]">{user.name}</div>
              <div className="text-[11px] text-[#a1a1aa]">{user.email}</div>
            </div>
            <button
              onClick={() => logout()}
              className="text-xs text-[#a1a1aa] hover:text-[#fafafa] transition-colors cursor-pointer px-2.5 py-1 rounded hover:bg-[#19191c]"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      {/* Main application shell */}
      <main className="flex-1 max-w-6xl w-full mx-auto p-6 space-y-6">
        <div className="bg-[#111113] border border-[#27272a] rounded-lg p-6">
          <h2 className="text-lg font-medium text-[#fafafa] mb-1">
            Welcome back, {user.name}
          </h2>
          <p className="text-sm text-[#a1a1aa]">
            You are signed in to Meridian, an engineering prototype for reliable background work and project access.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-[#111113] border border-[#27272a] rounded-lg p-5">
            <h3 className="text-sm font-medium text-[#fafafa] mb-2">
              Project access
            </h3>
            <p className="text-xs text-[#a1a1aa] leading-relaxed">
              Project creation and membership operations are implemented in the backend API, but the frontend has no project-management interface. Job and worker management remain unavailable until queue access is project-scoped.
            </p>
          </div>

          <div className="bg-[#111113] border border-[#27272a] rounded-lg p-5">
            <h3 className="text-sm font-medium text-[#fafafa] mb-2">
              Execution lifecycle
            </h3>
            <p className="text-xs text-[#a1a1aa] leading-relaxed">
              The API implements PostgreSQL-backed attempts, worker leases and heartbeats, retries, cancellation, and expiry recovery. Global scheduling is disabled by default, and the worker currently simulates execution.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
