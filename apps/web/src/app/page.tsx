'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Brand } from '@/components/Brand';
import { useAuth } from '@/lib/auth-context';

const POINTS = [
  { title: 'Capture anything', text: 'Notes, snippets, ideas, saved links and uploaded documents, organised with folders and tags.' },
  { title: 'Search by meaning', text: 'Find items about the same idea, even when you don’t remember the exact words.' },
  { title: 'Ask your notes', text: 'Ask in plain language, or by voice, and get answers that link back to the notes they came from.' },
];

export default function Home() {
  const { user, loading } = useAuth();
  const router = useRouter();

  // People who are signed in go straight to their notes; everyone else sees the introduction.
  useEffect(() => {
    if (!loading && user) router.replace('/notes');
  }, [user, loading, router]);

  if (loading || user) return null;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between gap-3">
        <Brand />
        <Link href="/login" className="btn-primary">Sign in</Link>
      </header>

      <section className="flex flex-col gap-3">
        <h1 className="font-serif text-3xl font-semibold sm:text-4xl">Your notes, connected and searchable by meaning.</h1>
        <p className="max-w-prose text-muted">MindMesh keeps everything you save in one place, links related ideas together and answers your questions from what you wrote.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/login" className="btn-primary">Get started</Link>
        </div>
      </section>

      <section aria-labelledby="tour-heading" className="flex flex-col gap-2">
        <h2 id="tour-heading" className="text-xs font-semibold uppercase tracking-wider text-muted">A quick tour (about 2 minutes)</h2>
        <video className="w-full rounded-xl border border-line bg-ink shadow-sm" controls preload="metadata" playsInline aria-label="MindMesh walkthrough video">
          <source src="/mindmesh-walkthrough.mp4" type="video/mp4" />
          Your browser can’t play this video.
        </video>
      </section>

      <ul className="grid gap-3 sm:grid-cols-3">
        {POINTS.map((p) => (
          <li key={p.title} className="rounded-xl border border-line bg-white p-4">
            <h3 className="font-serif text-lg font-semibold">{p.title}</h3>
            <p className="mt-1 text-sm text-muted">{p.text}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
