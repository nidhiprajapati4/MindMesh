'use client';

import type { ReactNode } from 'react';
import { LINK_RE, formatBytes, hostOf, isIndexing, linkKey, safeHref, type MatchedBy, type Note } from '@/lib/api';

type Props = {
  note: Note;
  folderName?: string;
  /** Set when the card is a search result. */
  match?: { snippet: string | null; matchedBy: MatchedBy };
  onOpen: () => void;
  onPatch: (data: Partial<Note>) => void;
  onTrash: () => void;
  onRestore: () => void;
  onDestroy: () => void;
  onRetry: () => void;
  /** Opens the note a [[link]] in the preview leads to. */
  onOpenNote?: (id: string) => void;
};

/** Shows [[links]] in a preview as links to the notes they lead to (plain text in code). */
function withLinks(text: string, note: Note, onOpenNote?: (id: string) => void): ReactNode {
  if (note.type === 'snippet' || !text.includes('[[')) return text;
  const target = new Map((note.outLinks ?? []).map((l) => [l.key, l.noteId]));
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK_RE)) {
    parts.push(text.slice(last, m.index));
    const title = m[1].replace(/\s+/g, ' ').trim();
    const id = target.get(linkKey(title));
    parts.push(
      id && onOpenNote ? (
        <button key={m.index} type="button" className="text-accent underline decoration-dotted underline-offset-2" onClick={() => onOpenNote(id)}>{title}</button>
      ) : (
        <span key={m.index} className="underline decoration-dotted underline-offset-2" title="No note with this title yet">{title}</span>
      )
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

const TYPE_BADGE: Record<Note['type'], string> = { note: 'Note', snippet: 'Snippet', url: 'Link', idea: 'Idea', document: 'Doc' };
const MATCH_LABEL: Record<MatchedBy, string> = { meaning: 'Matched by meaning', both: 'Matched by meaning and keywords', keyword: '' };

function ProcessingBadge({ note: n, onRetry }: { note: Note; onRetry: () => void }) {
  if (isIndexing(n)) {
    return (
      <span className="inline-flex items-center gap-1 rounded bg-paper px-1.5 py-0.5" title="Preparing this item for search by meaning">
        <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
        Processing…
      </span>
    );
  }
  if (n.processing?.status === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded bg-red-50 px-1.5 py-0.5 text-red-700" title={n.processing.error ?? undefined}>
        Failed
        <button className="font-medium underline" onClick={onRetry} aria-label={`Retry processing ${n.title || 'untitled item'}`}>Retry</button>
      </span>
    );
  }
  return null;
}

export function NoteCard({ note: n, folderName, match, onOpen, onPatch, onTrash, onRestore, onDestroy, onRetry, onOpenNote }: Props) {
  const trashed = !!n.deletedAt;
  const href = safeHref(n.sourceUrl);
  const preview = match?.snippet || n.content || n.metadata?.description || '';

  return (
    <li className={`rounded border bg-white p-4 ${n.pinned ? 'border-flag' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded bg-paper px-1.5 py-0.5 font-medium uppercase tracking-wide">{TYPE_BADGE[n.type] ?? n.type}</span>
            {n.type === 'snippet' && n.metadata?.language && <span className="font-mono">{n.metadata.language}</span>}
            {folderName && <span>in {folderName}</span>}
            {!trashed && !!n.backlinkCount && (
              <span className="inline-flex items-center gap-1" title={`${n.backlinkCount} note${n.backlinkCount === 1 ? '' : 's'} link here`}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
                </svg>
                <span className="sr-only">Linked from</span>{n.backlinkCount}
              </span>
            )}
            {!trashed && <ProcessingBadge note={n} onRetry={onRetry} />}
          </div>
          {trashed ? (
            <h2 className="font-serif text-lg font-semibold">{n.title || 'Untitled'}</h2>
          ) : (
            <button className="text-left" onClick={onOpen}>
              <h2 className="font-serif text-lg font-semibold">{n.title || 'Untitled'}</h2>
            </button>
          )}
          {href && (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="block truncate text-sm text-accent underline">
              {n.metadata?.siteName ? `${n.metadata.siteName} · ` : ''}{hostOf(href)}
            </a>
          )}
          {n.metadata?.fileName && (
            <p className="flex items-center gap-1 truncate text-xs text-muted">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="shrink-0">
                <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" /><path d="M14 3v6h6" />
              </svg>
              {n.metadata.fileName}
              {n.metadata.fileSize !== undefined && ` · ${formatBytes(n.metadata.fileSize)}`}
              {n.metadata.pageCount ? ` · ${n.metadata.pageCount} page${n.metadata.pageCount === 1 ? '' : 's'}` : ''}
            </p>
          )}
        </div>
        <time className="shrink-0 text-xs text-muted" dateTime={trashed ? n.deletedAt! : n.updatedAt}>
          {trashed ? 'Trashed ' : ''}{new Date(trashed ? n.deletedAt! : n.updatedAt).toLocaleDateString()}
        </time>
      </div>

      {!match?.snippet && !!n.keyPoints?.length ? (
        // Long notes, documents and saved links: their key points say more than the first lines.
        <ul className="mt-1 max-w-prose list-disc pl-5 font-serif text-muted" aria-label="Key points">
          {n.keyPoints.map((p, i) => <li key={i} className="line-clamp-2">{p}</li>)}
        </ul>
      ) : (
        preview && (
          <p className={`mt-1 line-clamp-3 max-w-prose whitespace-pre-wrap text-muted ${n.type === 'snippet' ? 'font-mono text-sm' : 'font-serif'}`}>{trashed ? preview : withLinks(preview, n, onOpenNote)}</p>
        )
      )}
      {match && MATCH_LABEL[match.matchedBy] && <p className="mt-1 text-xs text-accent">{MATCH_LABEL[match.matchedBy]}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        {n.tags.map((t) => <span key={t} className="rounded-full bg-paper px-2 py-0.5 text-xs">#{t}</span>)}
        <span className="ml-auto flex gap-3">
          {trashed ? (
            <>
              <button className="underline" onClick={onRestore}>Restore</button>
              <button className="text-red-700 underline" onClick={onDestroy}>Delete forever</button>
            </>
          ) : (
            <>
              <button className="underline" onClick={onOpen} aria-label={`Edit ${n.title || 'untitled item'}`}>Edit</button>
              <button className="underline" onClick={() => onPatch({ pinned: !n.pinned })}>{n.pinned ? 'Unpin' : 'Pin'}</button>
              <button className="underline" onClick={() => onPatch({ archived: !n.archived })}>{n.archived ? 'Unarchive' : 'Archive'}</button>
              <button className="text-red-700 underline" onClick={onTrash}>Delete</button>
            </>
          )}
        </span>
      </div>
    </li>
  );
}
