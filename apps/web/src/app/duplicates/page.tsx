'use client';

import Link from 'next/link';
import { Brand } from '@/components/Brand';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, type DuplicatePairs, type NoteBrief } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const message = errorMessage;

/** Likely duplicate pairs among your notes, side by side, to open or trash either one. */
export default function DuplicatesPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<DuplicatePairs | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  const load = useCallback(() => {
    api<DuplicatePairs>('/api/organize/duplicates')
      .then(setData)
      .catch((e) => setError(message(e, 'Could not look for duplicates')));
  }, []);

  useEffect(() => {
    if (user) load();
  }, [user, load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const trash = async (n: NoteBrief) => {
    if (!confirm(`Move “${n.title}” to the trash? You can restore it from the trash for 30 days.`)) return;
    try {
      await api(`/api/notes/${n._id}`, { method: 'DELETE' });
      setToast(`Moved “${n.title}” to the trash`);
      load();
    } catch (e) {
      setError(message(e, 'Could not move it to the trash'));
    }
  };

  if (loading || !user) return null;

  const Side = ({ n }: { n: NoteBrief }) => (
    <div className="flex min-w-0 flex-1 flex-col gap-1 rounded border border-line bg-white p-3">
      <span className="text-xs uppercase tracking-wide text-muted">{n.type}</span>
      <span className="font-serif font-semibold">{n.title}</span>
      {n.preview && <span className="line-clamp-3 text-sm text-muted">{n.preview}</span>}
      <span className="mt-auto flex gap-3 pt-2 text-sm">
        <Link href={`/notes?open=${n._id}`} className="underline">Open</Link>
        <button className="text-red-700 underline" onClick={() => trash(n)}>Move to trash</button>
      </span>
    </div>
  );

  return (
    <div className="mx-auto flex min-h-screen max-w-4xl flex-col gap-4 px-4 py-6">
      <Brand />
      <Link href="/notes" className="text-sm text-accent hover:underline">← Back to notes</Link>
      <h1 className="font-serif text-2xl font-semibold">Possible duplicates</h1>
      <p className="text-sm text-muted">Notes that say nearly the same thing, or save the same link. Nothing is changed unless you choose to.</p>

      {error && (
        <p role="alert" className="flex items-center justify-between rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
          <button className="underline" onClick={() => setError('')}>Dismiss</button>
        </p>
      )}

      {!data ? (
        <p className="text-muted">Comparing your notes…</p>
      ) : !data.pairs.length ? (
        <p className="text-muted">No likely duplicates found among your {data.scanned} notes.</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {data.pairs.map((p) => (
            <li key={`${p.a._id}:${p.b._id}`} className="flex flex-col gap-2">
              <span className="text-xs text-muted">{p.reason === 'same-link' ? 'Same link saved twice' : `${Math.round(p.score * 100)}% similar`}</span>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Side n={p.a} />
                <Side n={p.b} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {data?.capped && <p className="text-xs text-muted">Only your {data.scanned} most recently updated notes were compared.</p>}

      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded bg-ink px-4 py-2 text-sm text-white shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
