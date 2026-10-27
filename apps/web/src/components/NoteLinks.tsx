'use client';

import { useEffect, useState } from 'react';
import { api, type NoteBrief, type NoteLinks as LinksData } from '@/lib/api';

type Props = {
  noteId: string;
  onOpenNote: (id: string) => void;
  /** Creates a note with this title (for a link to a note that doesn't exist yet) and opens it. */
  onCreateNote: (title: string) => void;
};

function NoteButton({ note, onOpenNote }: { note: NoteBrief; onOpenNote: (id: string) => void }) {
  return (
    <button type="button" className="text-left text-sm font-medium hover:underline" onClick={() => onOpenNote(note._id)}>
      {note.title}
    </button>
  );
}

/** The notes this one links to ([[Title]] in its saved text), and the notes linking to it. */
export function NoteLinks({ noteId, onOpenNote, onCreateNote }: Props) {
  const [data, setData] = useState<LinksData | null>(null);

  useEffect(() => {
    let live = true;
    api<LinksData>(`/api/connections/links/${noteId}`)
      .then((d) => live && setData(d))
      .catch(() => live && setData({ outgoing: [], backlinks: [] }));
    return () => {
      live = false;
    };
  }, [noteId]);

  return (
    <section aria-labelledby="links-heading" className="rounded border border-line bg-paper/60 px-3 py-2">
      <h3 id="links-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Links</h3>
      {!data ? (
        <p className="mt-1 text-xs text-muted">Loading links…</p>
      ) : !data.outgoing.length && !data.backlinks.length ? (
        <p className="mt-1 text-xs text-muted">No links yet. Type [[ in the text to link another note.</p>
      ) : (
        <div className="mt-1 grid gap-2 sm:grid-cols-2">
          <div>
            <h4 className="text-xs text-muted">Links to</h4>
            {!data.outgoing.length ? (
              <p className="text-xs text-muted">Nothing yet.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {data.outgoing.map((l) => (
                  <li key={l.title}>
                    {l.note ? (
                      <NoteButton note={l.note} onOpenNote={onOpenNote} />
                    ) : (
                      <span className="text-sm">
                        <span className="text-muted line-through decoration-dotted">{l.title}</span>{' '}
                        {l.state === 'trashed' ? (
                          <span className="text-xs text-muted">· in the trash</span>
                        ) : (
                          <span className="text-xs text-muted">
                            · not created yet ·{' '}
                            <button type="button" className="text-accent underline" onClick={() => onCreateNote(l.title)}>Create it</button>
                          </span>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="text-xs text-muted">Linked from</h4>
            {!data.backlinks.length ? (
              <p className="text-xs text-muted">No notes link here yet.</p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {data.backlinks.map((n) => <li key={n._id}><NoteButton note={n} onOpenNote={onOpenNote} /></li>)}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
