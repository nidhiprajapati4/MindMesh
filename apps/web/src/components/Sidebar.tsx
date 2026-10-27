'use client';

import Link from 'next/link';
import { useRef, useState, type FormEvent } from 'react';
import { NOTE_TYPES, TYPE_LABELS, type Folder, type FolderList, type NoteType } from '@/lib/api';

export type View = 'active' | 'archived' | 'trash';
export type Filters = { view: View; type: NoteType | ''; folder: string; tag: string };

type Props = {
  filters: Filters;
  onChange: (f: Partial<Filters>) => void;
  folders: FolderList;
  tags: string[];
  /** Resolve to an error message, or '' on success. */
  onCreateFolder: (name: string) => Promise<string>;
  onRenameFolder: (f: Folder, name: string) => Promise<string>;
  onDeleteFolder: (f: Folder) => void;
  onNewNote: () => void;
  onUpload: () => void;
  onLogout: () => void;
};

const item = (active: boolean) =>
  `flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm ${active ? 'bg-accent text-white' : 'hover:bg-white'}`;
const chip = (active: boolean) =>
  `rounded-full border px-2.5 py-0.5 text-xs ${active ? 'border-accent bg-accent text-white' : 'border-line bg-white hover:border-accent'}`;
const iconBtn = 'shrink-0 rounded p-1 text-muted hover:bg-white hover:text-ink';

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{children}</h2>;
}

const Divider = () => <hr className="border-line" />;

const svgProps = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const PencilIcon = () => (
  <svg {...svgProps}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
const TrashIcon = () => (
  <svg {...svgProps}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></svg>
);
const FolderIcon = () => (
  <svg {...svgProps} className="shrink-0"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
);

export function Sidebar({ filters, onChange, folders, tags, onCreateFolder, onRenameFolder, onDeleteFolder, onNewNote, onUpload, onLogout }: Props) {
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [folderError, setFolderError] = useState('');
  // Enter submits and the input then blurs; this stops the blur from submitting a second time.
  const busy = useRef(false);

  const startNew = () => {
    setRenaming(null);
    setFolderError('');
    setNewFolder('');
  };
  const startRename = (f: Folder) => {
    setNewFolder(null);
    setFolderError('');
    setRenaming({ id: f._id, name: f.name });
  };
  const cancelEdit = () => {
    setNewFolder(null);
    setRenaming(null);
    setFolderError('');
  };

  const addFolder = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy.current) return;
    const name = newFolder?.trim();
    if (!name) return cancelEdit();
    busy.current = true;
    const err = await onCreateFolder(name);
    busy.current = false;
    if (err) setFolderError(err);
    else cancelEdit();
  };

  const rename = async (f: Folder, e?: FormEvent) => {
    e?.preventDefault();
    if (busy.current || !renaming) return;
    const name = renaming.name.trim();
    if (!name || name === f.name) return cancelEdit();
    busy.current = true;
    const err = await onRenameFolder(f, name);
    busy.current = false;
    if (err) setFolderError(err);
    else cancelEdit();
  };

  const errorLine = folderError && <p role="alert" className="px-1 pt-1 text-xs text-red-700">{folderError}</p>;

  return (
    <aside className="flex flex-col gap-4 md:sticky md:top-6 md:max-h-[calc(100vh-3rem)] md:overflow-y-auto md:pr-1">
      <h1 className="font-serif text-3xl font-semibold">MindMesh</h1>
      <div className="flex flex-col gap-2">
        <button className="btn-primary" onClick={onNewNote}>
          New item <kbd className="ml-1 rounded bg-white/20 px-1 text-xs">N</kbd>
        </button>
        <button className="btn-ghost" onClick={onUpload}>Upload file</button>
        <Link href="/ask" className="btn-ghost flex items-center justify-center gap-1.5" title="Ask a question and get an answer from your notes ( ? )">
          Ask your notes <kbd className="rounded bg-paper px-1 text-[10px] text-muted">?</kbd>
        </Link>
        <Link href="/graph" className="text-center text-xs text-accent hover:underline">Graph of your notes</Link>
        <Link href="/duplicates" className="text-center text-xs text-accent hover:underline">Find possible duplicates</Link>
      </div>

      <Divider />

      <nav aria-label="Views" className="flex flex-col gap-0.5">
        {(['active', 'archived', 'trash'] as const).map((v) => (
          <button key={v} className={item(filters.view === v)} aria-pressed={filters.view === v} onClick={() => onChange({ view: v })}>
            {v === 'active' ? 'All items' : v === 'archived' ? 'Archived' : 'Trash'}
          </button>
        ))}
      </nav>

      <Divider />

      <section aria-labelledby="types-heading">
        <SectionHeading id="types-heading">Type</SectionHeading>
        <div className="flex flex-wrap gap-1.5">
          {NOTE_TYPES.map((t) => (
            <button key={t} aria-pressed={filters.type === t} onClick={() => onChange({ type: filters.type === t ? '' : t })} className={chip(filters.type === t)}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </section>

      <Divider />

      <section aria-labelledby="folders-heading">
        <div className="mb-1.5 flex items-center justify-between">
          <SectionHeading id="folders-heading">Folders</SectionHeading>
          <button className="text-xs font-medium text-accent hover:underline" onClick={startNew}>+ New folder</button>
        </div>
        <div className="flex flex-col gap-0.5">
          <button className={item(filters.folder === '')} aria-pressed={filters.folder === ''} onClick={() => onChange({ folder: '' })}>
            All folders
          </button>
          <button className={item(filters.folder === 'none')} aria-pressed={filters.folder === 'none'} onClick={() => onChange({ folder: 'none' })}>
            Unfiled <span className="text-xs opacity-70">{folders.unfiledCount}</span>
          </button>
          {folders.folders.map((f) =>
            renaming?.id === f._id ? (
              <form key={f._id} onSubmit={(e) => rename(f, e)}>
                <input autoFocus className="field py-1" aria-label={`New name for folder ${f.name}`} value={renaming.name} maxLength={60}
                  onChange={(e) => { setFolderError(''); setRenaming({ id: f._id, name: e.target.value }); }} onBlur={() => (folderError ? cancelEdit() : rename(f))}
                  onKeyDown={(e) => e.key === 'Escape' && cancelEdit()} />
                {errorLine}
              </form>
            ) : (
              <div key={f._id} className="flex items-center gap-0.5">
                <button className={item(filters.folder === f._id)} aria-pressed={filters.folder === f._id} onClick={() => onChange({ folder: f._id })}
                  onDoubleClick={() => startRename(f)} title="Double-click to rename">
                  <span className="flex min-w-0 items-center gap-1.5"><FolderIcon /><span className="truncate">{f.name}</span></span>
                  <span className="text-xs opacity-70">{f.noteCount}</span>
                </button>
                <button className={iconBtn} onClick={() => startRename(f)} aria-label={`Rename folder ${f.name}`} title="Rename"><PencilIcon /></button>
                <button className={`${iconBtn} hover:text-red-700`} onClick={() => onDeleteFolder(f)} aria-label={`Delete folder ${f.name}`} title="Delete"><TrashIcon /></button>
              </div>
            )
          )}
          {newFolder !== null && (
            <form onSubmit={addFolder}>
              <input autoFocus className="field py-1" placeholder="Folder name, then Enter" aria-label="New folder name" value={newFolder} maxLength={60}
                onChange={(e) => { setFolderError(''); setNewFolder(e.target.value); }} onBlur={() => (folderError ? cancelEdit() : addFolder())} onKeyDown={(e) => e.key === 'Escape' && cancelEdit()} />
              {errorLine}
            </form>
          )}
          {!folders.folders.length && newFolder === null && <p className="px-2 py-1 text-xs text-muted">No folders yet.</p>}
        </div>
      </section>

      {!!tags.length && (
        <>
          <Divider />
          <section aria-labelledby="tags-heading">
            <SectionHeading id="tags-heading">Tags</SectionHeading>
            <div className="flex flex-wrap gap-1.5">
              {tags.map((t) => (
                <button key={t} onClick={() => onChange({ tag: filters.tag === t ? '' : t })} aria-pressed={filters.tag === t} className={chip(filters.tag === t)}>
                  #{t}
                </button>
              ))}
            </div>
          </section>
        </>
      )}

      <Divider />
      <button className="btn-ghost" onClick={onLogout}>Sign out</button>
    </aside>
  );
}
