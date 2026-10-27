'use client';

import { useEffect, useState } from 'react';
import { api, type Suggestions as SuggestionData } from '@/lib/api';

const DEBOUNCE_MS = 800;
const MIN_CHARS = 20;

type DraftLike = { id?: string; title: string; content: string; tags: string; folderId: string; sourceUrl: string };

const toTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];

/**
 * Asks the server for tag, folder and duplicate suggestions once typing pauses.
 * Never blocks editing: failures and slow responses simply show nothing.
 */
export function useSuggestions(draft: DraftLike, enabled: boolean): SuggestionData | null {
  const [data, setData] = useState<SuggestionData | null>(null);
  const key = JSON.stringify([draft.id, draft.title, draft.content, draft.tags, draft.folderId, draft.sourceUrl]);

  useEffect(() => {
    const enough = `${draft.title} ${draft.content}`.trim().length >= MIN_CHARS || !!draft.sourceUrl.trim();
    if (!enabled || !enough) return setData(null);
    const controller = new AbortController();
    const t = setTimeout(() => {
      api<SuggestionData>('/api/organize/suggest', {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({
          title: draft.title,
          content: draft.content,
          sourceUrl: draft.sourceUrl.trim() || null,
          tags: toTags(draft.tags),
          folderId: draft.folderId || null,
          ...(draft.id ? { noteId: draft.id } : {}),
        }),
      })
        .then(setData)
        .catch(() => undefined); // suggestions are optional
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
    // `key` captures every field that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);

  return data;
}

type Props = {
  data: SuggestionData | null;
  onAddTag: (tag: string) => void;
  onSetFolder: (id: string) => void;
  onOpenNote: (id: string) => void;
};

/** Suggested tags and folder (one click to accept), plus a warning about likely duplicates. */
export function SuggestionBar({ data, onAddTag, onSetFolder, onOpenNote }: Props) {
  if (!data) return null;
  const { tags, folder, duplicates } = data;
  if (!tags.length && !folder && !duplicates.length) return null;

  return (
    <div className="flex flex-col gap-2 text-sm">
      {duplicates.slice(0, 2).map((d) => (
        <p key={d._id} role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-amber-800">
          {d.reason === 'same-link' ? 'You already saved this link as ' : 'This looks like '}
          <strong>{d.title}</strong>
          {d.reason === 'similar' && ` (${Math.round(d.score * 100)}% similar)`}.{' '}
          <button type="button" className="underline" onClick={() => onOpenNote(d._id)}>Open it</button>
          <span className="text-amber-700"> · or keep editing and save anyway.</span>
        </p>
      ))}
      {(!!tags.length || folder) && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted">Suggested:</span>
          {tags.map((t) => (
            <button
              key={t.tag}
              type="button"
              onClick={() => onAddTag(t.tag)}
              className="rounded-full border border-dashed border-accent px-2 py-0.5 text-xs text-accent hover:bg-accent hover:text-white"
              aria-label={`Add tag ${t.tag}`}
            >
              + #{t.tag}
            </button>
          ))}
          {folder && (
            <button
              type="button"
              onClick={() => onSetFolder(folder._id)}
              className="rounded-full border border-dashed border-accent px-2 py-0.5 text-xs text-accent hover:bg-accent hover:text-white"
              aria-label={`Move to folder ${folder.name}`}
            >
              Move to {folder.name}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
