'use client';

import { formatBytes, hostOf, safeHref, type Note } from '@/lib/api';

type Props = {
  note: Note;
  folderName?: string;
  onOpen: () => void;
  onPatch: (data: Partial<Note>) => void;
  onTrash: () => void;
  onRestore: () => void;
  onDestroy: () => void;
};

const TYPE_BADGE: Record<Note['type'], string> = { note: 'Note', snippet: 'Snippet', url: 'Link', idea: 'Idea', document: 'Doc' };

export function NoteCard({ note: n, folderName, onOpen, onPatch, onTrash, onRestore, onDestroy }: Props) {
  const trashed = !!n.deletedAt;
  const href = safeHref(n.sourceUrl);
  const preview = n.content || n.metadata?.description || '';

  return (
    <li className={`rounded border bg-white p-4 ${n.pinned ? 'border-flag' : 'border-line'}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="rounded bg-paper px-1.5 py-0.5 font-medium uppercase tracking-wide">{TYPE_BADGE[n.type] ?? n.type}</span>
            {n.type === 'snippet' && n.metadata?.language && <span className="font-mono">{n.metadata.language}</span>}
            {folderName && <span>in {folderName}</span>}
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

      {preview && (
        <p className={`mt-1 line-clamp-3 max-w-prose whitespace-pre-wrap text-muted ${n.type === 'snippet' ? 'font-mono text-sm' : 'font-serif'}`}>{preview}</p>
      )}

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
