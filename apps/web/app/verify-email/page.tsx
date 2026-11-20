'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api';

type PageState = 'ready' | 'submitting' | 'sent' | 'verified' | 'error';

export default function VerifyEmailPage() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<PageState>('ready');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get('token');
    if (!token) return;

    window.history.replaceState(null, '', window.location.pathname);
    void Promise.resolve()
      .then(() => {
        setState('submitting');
        return api.auth.confirmEmailVerification(token);
      })
      .then((result) => {
        setState('verified');
        setMessage(result.data.message);
      })
      .catch(() => {
        setState('error');
        setMessage('This verification link is invalid or expired. Request a new link to try again.');
      });
  }, []);

  async function requestLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setState('submitting');
    setMessage(null);
    try {
      const result = await api.auth.requestEmailVerification(email);
      setState('sent');
      setMessage(result.data.message);
    } catch (error) {
      setState('error');
      setMessage(error instanceof ApiError
        ? error.message
        : 'Email verification is temporarily unavailable. Please try again later.');
    }
  }

  return (
    <main className="min-h-screen bg-[#0a0a0b] text-[#fafafa] flex items-center justify-center p-4">
      <section className="w-full max-w-md rounded-lg border border-[#27272a] bg-[#111113] p-8">
        <h1 className="text-xl font-semibold">Verify your Meridian email</h1>
        {message && (
          <p role={state === 'error' ? 'alert' : 'status'} className="mt-4 text-sm text-[#d4d4d8]">
            {message}
          </p>
        )}
        {state === 'ready' || state === 'sent' || state === 'error' ? (
          <form onSubmit={requestLink} className="mt-6 space-y-4">
            <label htmlFor="verification-email" className="block text-sm text-[#a1a1aa]">
              Request a verification link
            </label>
            <input
              id="verification-email"
              type="email"
              autoComplete="email"
              required
              maxLength={255}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded border border-[#27272a] bg-[#19191c] px-3 py-2 text-sm"
            />
            <button
              type="submit"
              className="rounded bg-[#6366f1] px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Send verification link
            </button>
          </form>
        ) : null}
        {state === 'verified' && (
          <Link href="/login" className="mt-6 inline-block text-sm text-[#a5b4fc] hover:underline">
            Continue to sign in
          </Link>
        )}
      </section>
    </main>
  );
}
