'use client';

import React, { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/contexts/AuthContext';
import { ApiError } from '@/lib/api';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMessage(null);

    if (!email || !password) {
      setErrorMessage('Please enter both email and password.');
      return;
    }

    setSubmitting(true);
    try {
      await login({ email, password });
      router.push('/');
    } catch (err) {
      if (err instanceof ApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage('An unexpected error occurred. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0a0a0b] text-[#fafafa] flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-[#111113] border border-[#27272a] rounded-lg p-8 shadow-sm">
        <div className="mb-6">
          <h1 className="text-xl font-semibold tracking-tight text-[#fafafa]">
            Sign in to Meridian
          </h1>
          <p className="text-sm text-[#a1a1aa] mt-1">
            Enter your email and password to access your account.
          </p>
        </div>

        {errorMessage && (
          <div
            role="alert"
            className="mb-4 p-3 rounded bg-[#450a0a] border border-[#ef4444]/40 text-sm text-[#fca5a5]"
          >
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label
              htmlFor="email"
              className="block text-xs font-medium uppercase tracking-wider text-[#a1a1aa] mb-1.5"
            >
              Email address
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="w-full h-10 px-3 rounded bg-[#19191c] border border-[#27272a] text-sm text-[#fafafa] placeholder-[#52525b] focus:outline-none focus:border-[#6366f1] transition-colors"
              placeholder="you@example.com"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="block text-xs font-medium uppercase tracking-wider text-[#a1a1aa] mb-1.5"
            >
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full h-10 px-3 rounded bg-[#19191c] border border-[#27272a] text-sm text-[#fafafa] placeholder-[#52525b] focus:outline-none focus:border-[#6366f1] transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full h-10 rounded bg-[#6366f1] hover:bg-[#4f46e5] text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            {submitting ? 'Signing in...' : 'Sign in'}
          </button>
        </form>

        <div className="mt-6 pt-6 border-t border-[#27272a] text-center text-sm text-[#a1a1aa]">
          Do not have an account?{' '}
          <Link
            href="/register"
            className="text-[#6366f1] hover:underline font-medium"
          >
            Create one
          </Link>
          <p className="mt-3">
            <Link href="/verify-email" className="text-[#6366f1] hover:underline font-medium">
              Verify your email
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
