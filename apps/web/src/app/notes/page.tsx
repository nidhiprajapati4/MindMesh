'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { NoteCard } from '@/components/NoteCard';
import { NoteEditor, blankDraft, type Draft } from '@/components/NoteEditor';
import { Sidebar, type Filters } from '@/components/Sidebar';
import { api, TYPE_LABELS, type Folder, type FolderList, type Note, type NoteList, type NoteMetadata } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const PAGE_SIZE = 20;
type Sort = 'auto' | 'updated' | 'created' | 'title';

const toTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
const cleanMeta = (m: NoteMetadata) => Object.fromEntries(Object.entries(m).filter(([, v]) => v?.trim())) as NoteMetadata;
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

const toDraft = (n: Note): Draft => ({
  id: n._id,
  type: n.type ?? 'note',
  title: n.title,
  content: n.content,
  tags: n.tags.join(', '),
  folderId: n.folderId ?? '',
  sourceUrl: n.sourceUrl ?? '',
  metadata: n.metadata ?? {},
});

export default function NotesPage() {
  const { user, loading, logout } = useAuth();
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);

  const [filters, setFilters] = useState<Filters>({ view: 'active', type: '', folder: '', tag: '' });
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<Sort>('auto');
  const [list, setList] = useState<NoteList | null>(null);
  const [folders, setFolders] = useState<FolderList>({ folders: [], unfiledCount: 0 });
  const [tags, setTags] = useState<string[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [captureUrl, setCaptureUrl] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [toast, setToast] = useState<{ text: string; undo?: () => void } | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  const fetchPage = useCallback(
    (page: number, limit = PAGE_SIZE) => {
      const p = new URLSearchParams({ view: filters.view, page: String(page), limit: String(limit) });
      if (q) p.set('q', q);
      if (filters.type) p.set('type', filters.type);
      if (filters.folder) p.set('folder', filters.folder);
      if (filters.tag) p.set('tag', filters.tag);
      p.set('sort', sort === 'auto' ? (q ? 'relevance' : 'updated') : sort);
      return api<NoteList>(`/api/notes?${p}`);
    },
    [filters, q, sort]
  );

  const loadSidebar = useCallback(async () => {
    const [f, t] = await Promise.all([api<FolderList>('/api/folders'), api<string[]>('/api/notes/tags')]);
    setFolders(f);
    setTags(t);
  }, []);

  /** Reloads everything, keeping as many rows as are currently shown. */
  const refresh = useCallback(
    async (keep = PAGE_SIZE) => {
      try {
        const [l] = await Promise.all([fetchPage(1, Math.min(100, Math.max(PAGE_SIZE, keep))), loadSidebar()]);
        setList(l);
        setError('');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not load items');
      }
    },
    [fetchPage, loadSidebar]
  );

  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => refresh(), 250);
    return () => clearTimeout(t);
  }, [user, refresh]);

  const loadMore = async () => {
    if (!list) return;
    try {
      const next = await fetchPage(Math.floor(list.items.length / PAGE_SIZE) + 1);
      const seen = new Set(list.items.map((n) => n._id));
      setList({ ...next, items: [...list.items, ...next.items.filter((n) => !seen.has(n._id))] });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load more');
    }
  };

  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refresh(list?.items.length);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    }
  };

  const currentFolderId = filters.folder && filters.folder !== 'none' ? filters.folder : '';
  const newNote = useCallback(() => setDraft(blankDraft(currentFolderId, filters.type || 'note')), [currentFolderId, filters.type]);

  // Quick-capture shortcuts: N = new item, / = search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'n' && !draft) {
        e.preventDefault();
        newNote();
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, newNote]);

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true);
    await act(async () => {
      const body = JSON.stringify({
        type: draft.type,
        title: draft.title,
        content: draft.content,
        tags: toTags(draft.tags),
        folderId: draft.folderId || null,
        sourceUrl: draft.sourceUrl.trim() || null,
        metadata: cleanMeta(draft.metadata),
      });
      await api(draft.id ? `/api/notes/${draft.id}` : '/api/notes', { method: draft.id ? 'PATCH' : 'POST', body });
      setDraft(null);
    });
    setSaving(false);
  };

  const capture = async (e: FormEvent) => {
    e.preventDefault();
    const url = captureUrl.trim();
    if (!url) return;
    setCapturing(true);
    await act(async () => {
      const note = await api<Note>('/api/notes/capture-url', {
        method: 'POST',
        body: JSON.stringify({ url: /^https?:\/\//i.test(url) ? url : `https://${url}`, folderId: currentFolderId || null }),
      });
      setCaptureUrl('');
      setToast({ text: `Saved “${note.title}”` });
    });
    setCapturing(false);
  };

  const patch = (n: Note, data: Partial<Note>) => act(() => api(`/api/notes/${n._id}`, { method: 'PATCH', body: JSON.stringify(data) }));

  const trash = (n: Note) =>
    act(async () => {
      await api(`/api/notes/${n._id}`, { method: 'DELETE' });
      setToast({ text: 'Moved to trash', undo: () => act(() => api(`/api/notes/${n._id}/restore`, { method: 'POST' })) });
    });

  const restore = (n: Note) => act(() => api(`/api/notes/${n._id}/restore`, { method: 'POST' }));
  const destroy = (n: Note) =>
    confirm('Delete this item forever? This cannot be undone.') && act(() => api(`/api/notes/${n._id}/permanent`, { method: 'DELETE' }));
  const emptyTrash = () =>
    confirm('Permanently delete everything in the trash?') && act(() => api('/api/notes/trash', { method: 'DELETE' }));

  const createFolder = (name: string) => act(() => api('/api/folders', { method: 'POST', body: JSON.stringify({ name }) }));
  const renameFolder = (f: Folder, name: string) => act(() => api(`/api/folders/${f._id}`, { method: 'PATCH', body: JSON.stringify({ name }) }));
  const deleteFolder = (f: Folder) =>
    confirm(`Delete folder “${f.name}”? Its items are kept and become unfiled.`) &&
    act(async () => {
      await api(`/api/folders/${f._id}`, { method: 'DELETE' });
      if (filters.folder === f._id) setFilters((prev) => ({ ...prev, folder: '' }));
    });

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  if (loading || !user) return null;

  const folderName = new Map(folders.folders.map((f) => [f._id, f.name]));
  const items = list?.items ?? [];
  const filtered = !!(q || filters.type || filters.folder || filters.tag);
  const heading =
    filters.view === 'trash' ? 'Trash' : filters.view === 'archived' ? 'Archived' :
    filters.folder === 'none' ? 'Unfiled' : folderName.get(filters.folder) ?? (filters.type ? TYPE_LABELS[filters.type] : 'All items');

  return (
    <div className="mx-auto grid min-h-screen max-w-6xl gap-6 px-4 py-6 md:grid-cols-[16rem_1fr]">
      <Sidebar
        filters={filters}
        onChange={(f) => setFilters((prev) => ({ ...prev, ...f }))}
        folders={folders}
        tags={tags}
        onCreateFolder={createFolder}
        onRenameFolder={renameFolder}
        onDeleteFolder={async (f) => void deleteFolder(f)}
        onNewNote={newNote}
        onLogout={logout}
      />

      <main className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <input ref={searchRef} className="field flex-1" style={{ minWidth: '12rem' }} type="search" placeholder="Search  ( / )" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search items" />
          <select className="field w-auto" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
            <option value="auto">{q ? 'Best match' : 'Recently updated'}</option>
            <option value="updated">Recently updated</option>
            <option value="created">Recently created</option>
            <option value="title">Title A–Z</option>
          </select>
        </div>

        {filters.view === 'active' && (
          <form onSubmit={capture} className="flex gap-2">
            <input className="field flex-1" type="text" inputMode="url" placeholder="Paste a link to save it…" value={captureUrl} onChange={(e) => setCaptureUrl(e.target.value)} aria-label="Capture a URL" />
            <button className="btn-ghost" type="submit" disabled={capturing}>{capturing ? 'Saving…' : 'Save link'}</button>
          </form>
        )}

        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}

        {draft && <NoteEditor draft={draft} folders={folders.folders} saving={saving} onChange={setDraft} onSave={save} onCancel={() => setDraft(null)} />}

        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-serif text-xl font-semibold">
            {heading}
            {filters.tag && <span className="ml-2 text-base font-normal text-muted">#{filters.tag}</span>}
          </h2>
          <span className="text-sm text-muted" aria-live="polite">
            {list && `${list.total} item${list.total === 1 ? '' : 's'}`}
            {list?.matchMode === 'partial' && ' · partial-word matches'}
          </span>
        </div>

        {filters.view === 'trash' && !!items.length && (
          <div className="flex items-center justify-between rounded border border-line bg-white px-3 py-2 text-sm text-muted">
            Items in the trash are deleted forever after 30 days.
            <button className="text-red-700 underline" onClick={emptyTrash}>Empty trash</button>
          </div>
        )}

        {list && !items.length && !draft && (
          <p className="text-muted">
            {filtered ? 'Nothing matches. Try a different search or filter.' :
              filters.view === 'trash' ? 'The trash is empty.' :
              filters.view === 'archived' ? 'No archived items.' :
              'Nothing saved yet. Press N to write something, or paste a link above.'}
          </p>
        )}

        <ul className="flex flex-col gap-3">
          {items.map((n) => (
            <NoteCard
              key={n._id}
              note={n}
              folderName={filters.folder ? undefined : folderName.get(n.folderId ?? '')}
              onOpen={() => setDraft(toDraft(n))}
              onPatch={(d) => patch(n, d)}
              onTrash={() => trash(n)}
              onRestore={() => restore(n)}
              onDestroy={() => destroy(n)}
            />
          ))}
        </ul>

        {list && items.length < list.total && (
          <button className="btn-ghost self-center" onClick={loadMore}>Load more</button>
        )}
      </main>

      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded bg-ink px-4 py-2 text-sm text-white shadow-lg">
          {toast.text}
          {toast.undo && (
            <button className="font-semibold underline" onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>
          )}
        </div>
      )}
    </div>
  );
}
