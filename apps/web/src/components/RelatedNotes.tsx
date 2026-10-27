'use client';

import { useEffect, useState } from 'react';
import { api, type RelatedNotes as RelatedData } from '@/lib/api';

type Props = {
  noteId: string;
  onOpenNote: (id: string) => void;
  /** Adds a [[link]] to this related note; `isLinked` says whether the text already has one. */
  onLink?: (title: string) => void;
  isLinked?: (title: string) => boolean;
};

/** The notes most similar to this one (saved notes only). */
export function RelatedNotes({ noteId, onOpenNote, onLink, isLinked }: Props) {
  const [data, setData] = useState<RelatedData | null>(null);

  useEffect(() => {
    let live = true;
    api<RelatedData>(`/api/organize/related/${noteId}`)
      .then((d) => live && setData(d))
      .catch(() => live && setData({ items: [], pending: false }));
    return () => {
      live = false;
    };
  }, [noteId]);

  return (
    <section aria-labelledby="related-heading" className="rounded border border-line bg-paper/60 px-3 py-2">
      <h3 id="related-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Related notes</h3>
      {!data ? (
        <p className="mt-1 text-xs text-muted">Looking for similar notes…</p>
      ) : data.pending ? (
        <p className="mt-1 text-xs text-muted">This note is still being prepared; related notes will appear soon.</p>
      ) : !data.items.length ? (
        <p className="mt-1 text-xs text-muted">Nothing similar yet.</p>
      ) : (
        <ul className="mt-1 flex flex-col gap-1">
          {data.items.map(({ note }) => (
            <li key={note._id} className="flex items-start gap-2">
              <button type="button" className="min-w-0 flex-1 text-left text-sm hover:underline" onClick={() => onOpenNote(note._id)}>
                <span className="font-medium">{note.title}</span>
                {note.preview && <span className="block truncate text-xs text-muted">{note.preview}</span>}
              </button>
              {onLink && (isLinked?.(note.title) ? (
                <span className="shrink-0 text-xs text-muted">Linked</span>
              ) : (
                <button type="button" className="shrink-0 text-xs text-accent underline" onClick={() => onLink(note.title)} aria-label={`Link to ${note.title}`}>
                  Link
                </button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
