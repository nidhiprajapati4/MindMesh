'use client';

import { useState, type FormEvent } from 'react';
import { NOTE_TYPES, TYPE_LABELS, type Folder, type FolderList, type NoteType } from '@/lib/api';

export type View = 'active' | 'archived' | 'trash';
export type Filters = { view: View; type: NoteType | ''; folder: string; tag: string };

type Props = {
  filters: Filters;
  onChange: (f: Partial<Filters>) => void;
  folders: FolderList;
  tags: string[];
  onCreateFolder: (name: string) => Promise<void>;
  onRenameFolder: (f: Folder, name: string) => Promise<void>;
  onDeleteFolder: (f: Folder) => Promise<void>;
  onNewNote: () => void;
  onLogout: () => void;
};

const item = (active: boolean) =>
  `flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm ${active ? 'bg-accent text-white' : 'hover:bg-white'}`;

export function Sidebar({ filters, onChange, folders, tags, onCreateFolder, onRenameFolder, onDeleteFolder, onNewNote, onLogout }: Props) {
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const addFolder = async (e: FormEvent) => {
    e.preventDefault();
    if (!newFolder?.trim()) return setNewFolder(null);
    await onCreateFolder(newFolder.trim());
    setNewFolder(null);
  };

  const rename = async (e: FormEvent, f: Folder) => {
    e.preventDefault();
    if (renaming?.name.trim() && renaming.name.trim() !== f.name) await onRenameFolder(f, renaming.name.trim());
    setRenaming(null);
  };

  return (
    <aside className="flex flex-col gap-5">
      <h1 className="font-serif text-3xl font-semibold">MindMesh</h1>
      <button className="btn-primary" onClick={onNewNote}>
        New item <kbd className="ml-1 rounded bg-white/20 px-1 text-xs">N</kbd>
      </button>

      <nav aria-label="Views" className="flex flex-col gap-0.5">
        {(['active', 'archived', 'trash'] as const).map((v) => (
          <button key={v} className={item(filters.view === v)} aria-pressed={filters.view === v} onClick={() => onChange({ view: v })}>
            {v === 'active' ? 'All items' : v === 'archived' ? 'Archived' : 'Trash'}
          </button>
        ))}
      </nav>

      <section aria-labelledby="types-heading">
        <h2 id="types-heading" className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Type</h2>
        <div className="flex flex-wrap gap-1.5">
          {NOTE_TYPES.map((t) => (
            <button key={t} aria-pressed={filters.type === t} onClick={() => onChange({ type: filters.type === t ? '' : t })}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${filters.type === t ? 'border-accent bg-accent text-white' : 'border-line bg-white'}`}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="folders-heading">
        <div className="mb-1 flex items-center justify-between">
          <h2 id="folders-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">Folders</h2>
          <button className="text-xs text-accent underline" onClick={() => setNewFolder('')}>+ Add</button>
        </div>
        <div className="flex flex-col gap-0.5">
          <button className={item(filters.folder === '')} aria-pressed={filters.folder === ''} onClick={() => onChange({ folder: '' })}>
            Everywhere
          </button>
          <button className={item(filters.folder === 'none')} aria-pressed={filters.folder === 'none'} onClick={() => onChange({ folder: 'none' })}>
            Unfiled <span className="text-xs opacity-70">{folders.unfiledCount}</span>
          </button>
          {folders.folders.map((f) =>
            renaming?.id === f._id ? (
              <form key={f._id} onSubmit={(e) => rename(e, f)}>
                <input autoFocus className="field py-1" aria-label="Folder name" value={renaming.name} maxLength={60}
                  onChange={(e) => setRenaming({ id: f._id, name: e.target.value })} onBlur={(e) => rename(e, f)}
                  onKeyDown={(e) => e.key === 'Escape' && setRenaming(null)} />
              </form>
            ) : (
              <div key={f._id} className="group flex items-center gap-1">
                <button className={item(filters.folder === f._id)} aria-pressed={filters.folder === f._id} onClick={() => onChange({ folder: f._id })}>
                  <span className="truncate">{f.name}</span> <span className="text-xs opacity-70">{f.noteCount}</span>
                </button>
                <button className="hidden text-xs text-muted underline group-hover:block group-focus-within:block" onClick={() => setRenaming({ id: f._id, name: f.name })}>Rename</button>
                <button className="hidden text-xs text-red-700 underline group-hover:block group-focus-within:block" onClick={() => onDeleteFolder(f)}>Delete</button>
              </div>
            )
          )}
          {newFolder !== null && (
            <form onSubmit={addFolder}>
              <input autoFocus className="field py-1" placeholder="Folder name" aria-label="New folder name" value={newFolder} maxLength={60}
                onChange={(e) => setNewFolder(e.target.value)} onBlur={addFolder} onKeyDown={(e) => e.key === 'Escape' && setNewFolder(null)} />
            </form>
          )}
        </div>
      </section>

      {!!tags.length && (
        <section aria-labelledby="tags-heading">
          <h2 id="tags-heading" className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">Tags</h2>
          <div className="flex flex-wrap gap-1.5">
            {tags.map((t) => (
              <button key={t} onClick={() => onChange({ tag: filters.tag === t ? '' : t })} aria-pressed={filters.tag === t}
                className={`rounded-full border px-2.5 py-0.5 text-xs ${filters.tag === t ? 'border-accent bg-accent text-white' : 'border-line bg-white'}`}>
                #{t}
              </button>
            ))}
          </div>
        </section>
      )}

      <button className="btn-ghost mt-auto" onClick={onLogout}>Sign out</button>
    </aside>
  );
}
