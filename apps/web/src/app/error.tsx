'use client';

import Link from 'next/link';
import { ApiError } from '@/lib/api';

/** Shown when a page fails to render: a way out, and a reference for support. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const reference = error instanceof ApiError ? error.requestId : error.digest;
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-3 px-4">
      <h1 className="font-serif text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted">This page ran into a problem. Your notes are safe. Try again, or go back to your notes.</p>
      {reference && <p className="text-xs text-muted">Reference: <code>{reference}</code></p>}
      <div className="flex gap-2">
        <button className="btn-primary" onClick={reset}>Try again</button>
        <Link href="/notes" className="btn-ghost">Go to your notes</Link>
      </div>
    </main>
  );
}
