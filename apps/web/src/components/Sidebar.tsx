'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { NOTE_TYPES, TYPE_LABELS, api, initialsOf, type Counts, type Profile, type Folder, type FolderList, type NoteType } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { Brand } from './Brand';

export type View = 'active' | 'archived' | 'trash';
export type Filters = { view: View; type: NoteType | ''; folder: string; tag: string; favourite: boolean };

type Props = {
  filters: Filters;
  onChange: (f: Partial<Filters>) => void;
  folders: FolderList;
  tags: string[];
  /** Numbers shown in brackets next to the labels; null until loaded. */
  counts: Counts | null;
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

/**
 * Every clickable line in the sidebar is the same kind of row: a small icon, a label with its count,
 * soft grey on hover and the selection colour when active. Fixed height, so rows never stretch.
 */
const row = (active: boolean) =>
  `flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-sm transition-colors ${
    active ? 'bg-select font-medium text-selectInk' : 'text-ink/85 hover:bg-ink/5'
  }`;
const iconBtn = 'shrink-0 rounded p-1 text-muted hover:bg-ink/5 hover:text-ink';
/** Tags beyond this many are behind "+N more", so a long tag list can't push the sidebar off screen. */
const TAGS_SHOWN = 6;

/** The count after a label, e.g. "Notes (3)": quiet, so the label stays the thing you read. */
function Count({ n }: { n: number | undefined }) {
  if (n === undefined) return null;
  return <span className="shrink-0 font-normal text-muted">({n})</span>;
}

function Label({ children, n }: { children: ReactNode; n?: number }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1">
      <span className="truncate">{children}</span>
      <Count n={n} />
    </span>
  );
}

function SectionLabel({ id, children, action }: { id: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-0.5 flex items-center justify-between px-2">
      <h2 id={id} className="text-xs font-medium text-muted">{children}</h2>
      {action}
    </div>
  );
}

const svgProps = { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true } as const;
const Icon = ({ d, className = '' }: { d: string; className?: string }) => (
  <svg {...svgProps} className={`shrink-0 ${className}`}><path d={d} /></svg>
);
const ICONS = {
  all: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  star: 'm12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5L12 17.8l-5.8 3.1 1.1-6.5L2.6 9.8l6.5-.9z',
  archive: 'M21 8v13H3V8M1 3h22v5H1zM10 12h4',
  trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6',
  ask: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.8-.9L3 21l2-5.2A8.4 8.4 0 0 1 3 11.5 8.5 8.5 0 0 1 12 3a8.5 8.5 0 0 1 9 8.5z',
  graph: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
} as const;

export function Sidebar({ filters, onChange, folders, tags, counts, onCreateFolder, onRenameFolder, onDeleteFolder, onNewNote, onUpload, onLogout, open, onClose }: Props) {
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
  const { user } = useAuth();
  // The name shown is the one saved on the profile page (falls back to the sign-in account's name).
  const [profileName, setProfileName] = useState<string | null>(null);
  useEffect(() => {
    if (!user) return;
    api<Profile>('/api/profile').then((p) => setProfileName(p.displayName)).catch(() => undefined);
    const onChange = (e: Event) => setProfileName((e as CustomEvent<string>).detail);
    window.addEventListener('mindmesh:profile-name', onChange);
    return () => window.removeEventListener('mindmesh:profile-name', onChange);
  }, [user]);
  const displayName = profileName || user?.displayName || '';
  const email = user?.email || '';

  const library: { key: string; label: string; icon: string; on: boolean; n: number | undefined; go: () => void }[] = [
    { key: 'all', label: 'All items', icon: ICONS.all, on: filters.view === 'active' && !filters.favourite, n: counts?.all, go: () => onChange({ view: 'active', favourite: false }) },
    { key: 'fav', label: 'Favourites', icon: ICONS.star, on: filters.favourite, n: counts?.favourites, go: () => onChange({ view: 'active', favourite: !filters.favourite }) },
    { key: 'arch', label: 'Archived', icon: ICONS.archive, on: filters.view === 'archived', n: counts?.archived, go: () => onChange({ view: 'archived', favourite: false }) },
    { key: 'trash', label: 'Trash', icon: ICONS.trash, on: filters.view === 'trash', n: counts?.trash, go: () => onChange({ view: 'trash', favourite: false }) },
  ];

  return (
    <>
    {drawerOpen && <div className="fixed inset-0 z-30 bg-ink/40 md:hidden" onClick={onClose} aria-hidden />}
    <aside
      ref={asideRef}
      id="sidebar"
      aria-label="Menu"
      inert={phone && !open}
      // The folder list takes the remaining height and scrolls inside itself only when it has to,
      // so the sidebar as a whole doesn't scroll on normal screens. Sections are told apart by
      // small grey headings and spacing, like a workspace side panel; on desktop it is a soft card.
      className={`fixed inset-y-0 left-0 z-40 flex w-72 max-w-[85vw] flex-col gap-2 overflow-y-auto bg-side p-3 shadow-xl transition-transform ${open ? 'translate-x-0' : '-translate-x-full'}
        md:z-20 md:w-64 md:max-w-none md:translate-x-0 md:border-r md:border-line md:shadow-none md:transition-none`}
    >
      <div className="flex flex-col gap-2 px-1 pt-0.5">
        <div className="flex items-center justify-between">
          <Brand heading />
          {phone && (
            <button className="rounded px-2 py-1 text-xl leading-none text-muted hover:bg-ink/5" onClick={onClose} aria-label="Close menu">×</button>
          )}
        </div>
        <div className="flex gap-1.5">
          <button className="btn-primary h-9 flex-1 text-sm shadow-sm" onClick={onNewNote}>
            New item <kbd className="ml-1 rounded bg-white/20 px-1 text-xs">N</kbd>
          </button>
          <button className="btn-ghost h-9 px-2.5" onClick={onUpload} aria-label="Upload file" title="Upload a file"><Icon d={ICONS.upload} /></button>
        </div>
      </div>

      <nav aria-label="Explore" className="flex flex-col border-t border-line pt-2">
        <Link href="/ask" className={row(false)} title="Ask a question and get an answer from your notes ( ? )">
          <Icon d={ICONS.ask} className="text-accent" /><Label n={counts?.conversations}>Ask</Label>
        </Link>
        <Link href="/graph" className={row(false)} title="Graph of your notes">
          <Icon d={ICONS.graph} className="text-accent" /><Label>Graph</Label>
        </Link>
        <Link href="/duplicates" className={row(false)} title="Find possible duplicates">
          <Icon d={ICONS.copy} className="text-accent" /><Label n={counts?.duplicates}>Duplicates</Label>
        </Link>
      </nav>

      <section aria-labelledby="library-heading" className="border-t border-line pt-2">
        <SectionLabel id="library-heading">Library</SectionLabel>
        <div className="flex flex-col">
          {library.map((l) => (
            <button key={l.key} className={row(l.on)} aria-pressed={l.on} onClick={l.go}>
              <Icon d={l.icon} className={l.key === 'fav' ? (l.on ? 'fill-flag text-flag' : 'text-muted') : 'text-muted'} />
              <Label n={l.n}>{l.label}</Label>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="types-heading" className="border-t border-line pt-2">
        <SectionLabel id="types-heading">Types</SectionLabel>
        <div className="flex flex-wrap gap-x-0.5">
          {NOTE_TYPES.map((t) => (
            <button key={t} aria-pressed={filters.type === t} onClick={() => onChange({ type: filters.type === t ? '' : t })} className={`${row(filters.type === t)} !w-auto shrink-0`}>
              <Label n={counts?.types[t]}>{TYPE_LABELS[t]}</Label>
            </button>
          ))}
        </div>
      </section>

      <section aria-labelledby="folders-heading" className="flex min-h-[5.5rem] flex-1 flex-col border-t border-line pt-2">
        <SectionLabel id="folders-heading" action={<button className="text-xs font-medium text-accent hover:underline" onClick={startNew}>+ New folder</button>}>Folders</SectionLabel>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <button className={row(filters.folder === '')} aria-pressed={filters.folder === ''} onClick={() => onChange({ folder: '' })}>
            <Icon d={ICONS.folder} className="text-muted" /><Label n={counts?.all}>All folders</Label>
          </button>
          <button className={row(filters.folder === 'none')} aria-pressed={filters.folder === 'none'} onClick={() => onChange({ folder: 'none' })}>
            <Icon d={ICONS.folder} className="text-muted" /><Label n={folders.unfiledCount}>Unfiled</Label>
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
              <div key={f._id} className="group flex items-center gap-0.5">
                <button className={row(filters.folder === f._id)} aria-pressed={filters.folder === f._id} onClick={() => onChange({ folder: f._id })}
                  onDoubleClick={() => startRename(f)} title="Double-click to rename">
                  <Icon d={ICONS.folder} className="text-accent" /><Label n={f.noteCount}>{f.name}</Label>
                </button>
                <button className={`${iconBtn} md:hidden md:group-hover:block md:group-focus-within:block`} onClick={() => startRename(f)} aria-label={`Rename folder ${f.name}`} title="Rename"><Icon d={ICONS.pencil} /></button>
                <button className={`${iconBtn} hover:text-red-700 md:hidden md:group-hover:block md:group-focus-within:block`} onClick={() => onDeleteFolder(f)} aria-label={`Delete folder ${f.name}`} title="Delete"><Icon d={ICONS.trash} /></button>
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
        <section aria-labelledby="tags-heading" className="border-t border-line pt-2">
          <SectionLabel id="tags-heading">Tags ({tags.length})</SectionLabel>
          <div className={`flex flex-wrap gap-1 px-1 ${allTags ? 'max-h-24 overflow-y-auto' : ''}`}>
            {shownTags.map((t) => (
              <button
                key={t}
                onClick={() => onChange({ tag: filters.tag === t ? '' : t })}
                aria-pressed={filters.tag === t}
                className={`max-w-full whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs transition-colors ${filters.tag === t ? 'bg-select font-medium text-selectInk' : 'bg-ink/5 text-ink/80 hover:bg-ink/10'}`}
              >
                <span className="truncate">#{t}</span> <Count n={counts?.tags[t]} />
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

      <div className="flex flex-col gap-1 border-t border-line pt-2">
        <Link href="/profile" className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-ink/5" aria-label="Your profile" title="Your profile">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-select text-xs font-semibold text-selectInk" aria-hidden>{initialsOf(displayName, email)}</span>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-medium">{displayName || email.split('@')[0] || 'Profile'}</span>
            <span className="block text-[11px] text-muted">Profile</span>
          </span>
        </Link>
        <button className="h-7 w-full rounded-md px-2 text-left text-sm text-muted transition-colors hover:bg-red-50 hover:text-red-700" onClick={onLogout}>Sign out</button>
      </div>
    </aside>
    </>
  );
}
