'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { NoteCard } from '@/components/NoteCard';
import { NoteEditor, blankDraft, type Draft } from '@/components/NoteEditor';
import { Sidebar, type Filters } from '@/components/Sidebar';
import {
  api,
  EDITABLE_METADATA_KEYS,
  TYPE_LABELS,
  type EditableMetadata,
  type Folder,
  type FolderList,
  type Note,
  type NoteList,
  type NoteMetadata,
} from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const PAGE_SIZE = 20;
type Sort = 'auto' | 'updated' | 'created' | 'title';

const toTags = (s: string) => [...new Set(s.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);
const isTyping = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));

/**
 * Only user-editable metadata is sent. On edit, empty strings are kept so the server clears that field;
 * on create they are dropped.
 */
const editableMeta = (m: NoteMetadata, keepEmpty: boolean) => {
  const out: EditableMetadata = {};
  for (const k of EDITABLE_METADATA_KEYS) {
    const v = m[k]?.trim() ?? '';
    if (v || (keepEmpty && m[k] !== undefined)) out[k] = v;
  }
  return out;
};

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
  const [editor, setEditor] = useState<{ draft: Draft; mode: 'write' | 'upload'; key: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState('');
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
      if (q.trim()) p.set('q', q.trim());
      if (filters.type) p.set('type', filters.type);
      if (filters.folder) p.set('folder', filters.folder);
      if (filters.tag) p.set('tag', filters.tag);
      p.set('sort', sort === 'auto' ? (q.trim() ? 'relevance' : 'updated') : sort);
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
  // Every list request gets a number; only the newest may update the list. Without this, a slow
  // response for old filters (e.g. a refresh after delete) can overwrite the view the user switched to.
  const requestSeq = useRef(0);
  const refresh = useCallback(
    async (keep = PAGE_SIZE) => {
      const seq = ++requestSeq.current;
      try {
        const [l] = await Promise.all([fetchPage(1, Math.min(100, Math.max(PAGE_SIZE, keep))), loadSidebar()]);
        if (seq !== requestSeq.current) return;
        setList(l);
        setError('');
      } catch (e) {
        if (seq === requestSeq.current) setError(message(e, 'Could not load items'));
      }
    },
    [fetchPage, loadSidebar]
  );
  // Actions finish after a re-render may have changed the filters, so always refresh with the latest ones.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const listRef = useRef(list);
  listRef.current = list;
  const refreshLatest = () => refreshRef.current(listRef.current?.items.length);

  useEffect(() => {
    if (!user) return;
    const t = setTimeout(() => refresh(), 250);
    return () => clearTimeout(t);
  }, [user, refresh]);

  // If the selected tag disappears (its last item was edited or trashed), stop filtering by it.
  useEffect(() => {
    if (filters.tag && list && !tags.includes(filters.tag) && filters.view === 'active') {
      setFilters((prev) => ({ ...prev, tag: '' }));
    }
  }, [tags, filters.tag, filters.view, list]);

  const loadMore = async () => {
    if (!list) return;
    const seq = requestSeq.current;
    try {
      const next = await fetchPage(Math.floor(list.items.length / PAGE_SIZE) + 1);
      if (seq !== requestSeq.current) return; // filters changed meanwhile
      const seen = new Set(list.items.map((n) => n._id));
      setList({ ...next, items: [...list.items, ...next.items.filter((n) => !seen.has(n._id))] });
    } catch (e) {
      setError(message(e, 'Could not load more'));
    }
  };

  /** Runs an action and refreshes; returns whether it succeeded. Errors show in the page banner. */
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refreshLatest();
      return true;
    } catch (e) {
      setError(message(e, 'Action failed'));
      return false;
    }
  };

  const currentFolderId = filters.folder && filters.folder !== 'none' ? filters.folder : '';
  const openEditor = useCallback(
    (draft: Draft, mode: 'write' | 'upload' = 'write') => {
      setEditorError('');
      setEditor({ draft, mode, key: Date.now() });
    },
    []
  );
  const newNote = useCallback(
    () => openEditor(blankDraft(currentFolderId, filters.type || 'note')),
    [openEditor, currentFolderId, filters.type]
  );
  const newUpload = () => openEditor(blankDraft(currentFolderId, 'document'), 'upload');
  const closeEditor = () => setEditor(null);

  // Quick-capture shortcuts: N = new item, / = search. Disabled while the editor is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editor || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        newNote();
      } else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor, newNote]);

  /** Editor actions report errors inside the dialog instead of the page banner. */
  const runEditor = async (fn: () => Promise<string>) => {
    setSaving(true);
    setEditorError('');
    try {
      const text = await fn();
      setEditor(null);
      setToast({ text });
      await refreshLatest();
    } catch (e) {
      setEditorError(message(e, 'Could not save'));
    } finally {
      setSaving(false);
    }
  };

  const save = () => {
    if (!editor || saving) return;
    const { draft } = editor;
    void runEditor(async () => {
      const body = JSON.stringify({
        type: draft.type,
        title: draft.title,
        content: draft.content,
        tags: toTags(draft.tags),
        folderId: draft.folderId || null,
        sourceUrl: draft.sourceUrl.trim() || null,
        metadata: editableMeta(draft.metadata, !!draft.id),
      });
      await api(draft.id ? `/api/notes/${draft.id}` : '/api/notes', { method: draft.id ? 'PATCH' : 'POST', body });
      return draft.id ? 'Changes saved' : 'Item created';
    });
  };

  const upload = (file: File, folderId: string, tagText: string) =>
    runEditor(async () => {
      const form = new FormData();
      form.append('file', file);
      form.append('folderId', folderId);
      form.append('tags', toTags(tagText).join(','));
      const note = await api<Note>('/api/notes/upload', { method: 'POST', body: form });
      return `Uploaded “${note.title}”${note.metadata?.truncated ? ' (text was cut off at 50,000 characters)' : ''}`;
    });

  const capture = async (e: FormEvent) => {
    e.preventDefault();
    const url = captureUrl.trim();
    if (!url || capturing) return;
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
      setToast({ text: 'Moved to trash', undo: () => void act(() => api(`/api/notes/${n._id}/restore`, { method: 'POST' })) });
    });

  const restore = (n: Note) => act(() => api(`/api/notes/${n._id}/restore`, { method: 'POST' }));
  const destroy = (n: Note) =>
    confirm('Delete this item forever? This cannot be undone.') && act(() => api(`/api/notes/${n._id}/permanent`, { method: 'DELETE' }));
  const emptyTrash = () =>
    confirm('Permanently delete everything in the trash?') && act(() => api('/api/notes/trash', { method: 'DELETE' }));

  /** Like act(), but returns the error message for the caller to show inline ('' on success). */
  const tryAct = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await refreshLatest();
      return '';
    } catch (e) {
      return message(e, 'Action failed');
    }
  };

  const createFolder = (name: string) => tryAct(() => api('/api/folders', { method: 'POST', body: JSON.stringify({ name }) }));
  const renameFolder = (f: Folder, name: string) =>
    tryAct(async () => {
      await api(`/api/folders/${f._id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      setToast({ text: `Renamed to “${name}”` });
    });
  const deleteFolder = (f: Folder) =>
    confirm(`Delete folder “${f.name}”? Its items are kept and become unfiled.`) &&
    void act(async () => {
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
  const filtered = !!(q.trim() || filters.type || filters.folder || filters.tag);
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
        onDeleteFolder={deleteFolder}
        onNewNote={newNote}
        onUpload={newUpload}
        onLogout={logout}
      />

      <main className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <input ref={searchRef} className="field min-w-48 flex-1" type="search" placeholder="Search  ( / )" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search items" />
          <select className="field w-auto" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort by">
            <option value="auto">{q.trim() ? 'Best match' : 'Recently updated'}</option>
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

        {error && (
          <p role="alert" className="flex items-center justify-between rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
            <button className="underline" onClick={() => setError('')}>Dismiss</button>
          </p>
        )}

        <div className="flex items-baseline justify-between gap-2">
          <h2 className="font-serif text-xl font-semibold">
            {heading}
            {filters.tag && <span className="ml-2 text-base font-normal text-muted">#{filters.tag}</span>}
          </h2>
          <span className="text-sm text-muted" aria-live="polite">
            {list && `${list.total} item${list.total === 1 ? '' : 's'}`}
            {list?.matchMode === 'partial' && list.total > 0 && ' · partial-word matches'}
          </span>
        </div>

        {filters.view === 'trash' && !!items.length && (
          <div className="flex items-center justify-between rounded border border-line bg-white px-3 py-2 text-sm text-muted">
            Items in the trash are deleted forever after 30 days.
            <button className="text-red-700 underline" onClick={emptyTrash}>Empty trash</button>
          </div>
        )}

        {list && !items.length && (
          <p className="text-muted">
            {filtered ? 'Nothing matches. Try a different search or filter.' :
              filters.view === 'trash' ? 'The trash is empty.' :
              filters.view === 'archived' ? 'No archived items.' :
              'Nothing saved yet. Press N to write something, upload a file, or paste a link above.'}
          </p>
        )}

        <ul className="flex flex-col gap-3">
          {items.map((n) => (
            <NoteCard
              key={n._id}
              note={n}
              folderName={filters.folder ? undefined : folderName.get(n.folderId ?? '')}
              onOpen={() => openEditor(toDraft(n))}
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

      {editor && (
        <NoteEditor
          key={editor.key}
          draft={editor.draft}
          initialMode={editor.mode}
          folders={folders.folders}
          saving={saving}
          error={editorError}
          onChange={(draft) => setEditor((prev) => prev && { ...prev, draft })}
          onSave={save}
          onCancel={closeEditor}
          onUpload={upload}
        />
      )}

      {toast && (
        <div role="status" className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded bg-ink px-4 py-2 text-sm text-white shadow-lg">
          {toast.text}
          {toast.undo && (
            <button className="font-semibold underline" onClick={() => { toast.undo!(); setToast(null); }}>Undo</button>
          )}
        </div>
      )}
    </div>
  );
}
