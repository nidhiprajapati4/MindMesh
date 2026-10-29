'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  /** Phones: the sidebar is a drawer, shown while `open`. */
  open: boolean;
  onClose: () => void;
};

const PHONE = '(max-width: 767px)';

/** Whether the screen is phone-sized (the sidebar is then a drawer). */
function usePhone() {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return phone;
}

const item = (active: boolean) =>
  `flex min-w-0 flex-1 items-center justify-between gap-2 rounded px-2 py-1 text-left text-sm ${active ? 'bg-accent text-white' : 'hover:bg-white'}`;
const chip = (active: boolean) =>
  `rounded-full border px-2 py-0.5 text-xs ${active ? 'border-accent bg-accent text-white' : 'border-line bg-white hover:border-accent'}`;
const iconBtn = 'shrink-0 rounded p-1 text-muted hover:bg-white hover:text-ink';
const linkBtn = 'rounded border border-line bg-white py-1.5 text-accent hover:border-accent';
/** Tags beyond this many are behind "+N more", so a long tag list can't push the sidebar off screen. */
const TAGS_SHOWN = 6;

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return <h2 id={id} className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">{children}</h2>;
}

const svgProps = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const PencilIcon = () => (
  <svg {...svgProps}><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
);
const TrashIcon = () => (
  <svg {...svgProps}><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" /></svg>
);
const UploadIcon = () => (
  <svg {...svgProps}><path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></svg>
);
const FolderIcon = () => (
  <svg {...svgProps} className="shrink-0"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" /></svg>
);

export function Sidebar({ filters, onChange, folders, tags, onCreateFolder, onRenameFolder, onDeleteFolder, onNewNote, onUpload, onLogout, open, onClose }: Props) {
  const phone = usePhone();
  const asideRef = useRef<HTMLElement>(null);
  const drawerOpen = phone && open;

  // Drawer: focus moves in when it opens; Esc closes it.
  useEffect(() => {
    if (!drawerOpen) return;
    asideRef.current?.querySelector<HTMLElement>('button, a, input')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawerOpen, onClose]);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [folderError, setFolderError] = useState('');
  const [allTags, setAllTags] = useState(false);
  const shownTags = allTags ? tags : tags.slice(0, TAGS_SHOWN);
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
    <>
    {drawerOpen && <div className="fixed inset-0 z-30 bg-ink/40 md:hidden" onClick={onClose} aria-hidden />}
    <aside
      ref={asideRef}
      id="sidebar"
      aria-label="Menu"
      inert={phone && !open}
      // The folder list takes the remaining height and scrolls inside itself only when it has to,
      // so the sidebar as a whole doesn't scroll on normal screens.
      className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col gap-3 overflow-y-auto bg-paper p-4 shadow-xl transition-transform ${open ? 'translate-x-0' : '-translate-x-full'}
        md:sticky md:inset-auto md:top-6 md:z-auto md:h-[calc(100vh-3rem)] md:w-auto md:max-w-none md:translate-x-0 md:bg-transparent md:p-0 md:pr-1 md:shadow-none md:transition-none`}
    >
      {phone && (
        <button className="self-end rounded px-2 py-1 text-xl leading-none text-muted hover:bg-white" onClick={onClose} aria-label="Close menu">×</button>
      )}
      <h1 className="font-serif text-2xl font-semibold leading-none">MindMesh</h1>
      <div className="flex gap-2">
        <button className="btn-primary flex-1" onClick={onNewNote}>
          New item <kbd className="ml-1 rounded bg-white/20 px-1 text-xs">N</kbd>
        </button>
        <button className="btn-ghost px-2.5" onClick={onUpload} aria-label="Upload file" title="Upload a file"><UploadIcon /></button>
      </div>
      <nav aria-label="Explore" className="grid grid-cols-3 gap-1 text-center text-xs font-medium">
        <Link href="/ask" className={linkBtn} title="Ask a question and get an answer from your notes ( ? )">Ask</Link>
        <Link href="/graph" className={linkBtn} title="Graph of your notes">Graph</Link>
        <Link href="/duplicates" className={linkBtn} title="Find possible duplicates">Duplicates</Link>
      </nav>

      <nav aria-label="Views" className="grid grid-cols-3 gap-0.5 rounded-lg border border-line bg-white p-0.5 text-xs font-medium">
        {(['active', 'archived', 'trash'] as const).map((v) => (
          <button key={v} className={`rounded-md py-1.5 ${filters.view === v ? 'bg-accent text-white' : 'hover:bg-paper'}`} aria-pressed={filters.view === v} onClick={() => onChange({ view: v })}>
            {v === 'active' ? 'All' : v === 'archived' ? 'Archived' : 'Trash'}
          </button>
        ))}
      </nav>

      <section aria-labelledby="types-heading">
        <SectionHeading id="types-heading">Type</SectionHeading>
        <div className="flex flex-wrap gap-1">
          {NOTE_TYPES.map((t) => (
            <button key={t} aria-pressed={filters.type === t} onClick={() => onChange({ type: filters.type === t ? '' : t })} className={chip(filters.type === t)}>
              {TYPE_LABELS[t]}
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="folders-heading" className="flex min-h-[7rem] flex-1 flex-col">
        <div className="mb-1 flex items-center justify-between">
          <SectionHeading id="folders-heading">Folders</SectionHeading>
          <button className="text-xs font-medium text-accent hover:underline" onClick={startNew}>+ New folder</button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
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
        <section aria-labelledby="tags-heading">
          <SectionHeading id="tags-heading">Tags</SectionHeading>
          <div className={`flex flex-wrap gap-1 ${allTags ? 'max-h-24 overflow-y-auto' : ''}`}>
            {shownTags.map((t) => (
              <button key={t} onClick={() => onChange({ tag: filters.tag === t ? '' : t })} aria-pressed={filters.tag === t} className={`${chip(filters.tag === t)} max-w-full truncate`}>
                #{t}
              </button>
            ))}
            {tags.length > TAGS_SHOWN && (
              <button className="px-1 text-xs font-medium text-accent hover:underline" aria-expanded={allTags} onClick={() => setAllTags(!allTags)}>
                {allTags ? 'Show fewer' : `+${tags.length - TAGS_SHOWN} more`}
              </button>
            )}
          </div>
        </section>
      )}

      <button className="rounded border border-line bg-white py-1.5 text-xs font-medium text-muted hover:bg-paper hover:text-ink" onClick={onLogout}>Sign out</button>
    </aside>
    </>
  );
}
