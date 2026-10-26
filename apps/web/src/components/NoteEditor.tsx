'use client';

import { NOTE_TYPES, TYPE_LABELS, type Folder, type NoteMetadata, type NoteType } from '@/lib/api';

export type Draft = {
  id?: string;
  type: NoteType;
  title: string;
  content: string;
  tags: string;
  folderId: string;
  sourceUrl: string;
  metadata: NoteMetadata;
};

export const blankDraft = (folderId = '', type: NoteType = 'note'): Draft => ({
  type,
  title: '',
  content: '',
  tags: '',
  folderId,
  sourceUrl: '',
  metadata: {},
});

type Props = {
  draft: Draft;
  folders: Folder[];
  saving: boolean;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
};

const SINGULAR: Record<NoteType, string> = { note: 'Note', snippet: 'Snippet', url: 'Link', idea: 'Idea', document: 'Document' };

export function NoteEditor({ draft, folders, saving, onChange, onSave, onCancel }: Props) {
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setMeta = (patch: NoteMetadata) => set({ metadata: { ...draft.metadata, ...patch } });
  const showSource = draft.type === 'url' || draft.type === 'document' || !!draft.sourceUrl;

  return (
    <section
      aria-label={draft.id ? 'Edit item' : 'New item'}
      className="flex flex-col gap-3 rounded border border-line bg-white p-4"
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          onSave();
        } else if (e.key === 'Escape') onCancel();
      }}
    >
      <div className="flex flex-wrap gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Type</span>
          <select className="field w-auto py-1" value={draft.type} onChange={(e) => set({ type: e.target.value as NoteType })}>
            {NOTE_TYPES.map((t) => <option key={t} value={t}>{SINGULAR[t]}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted">Folder</span>
          <select className="field w-auto py-1" value={draft.folderId} onChange={(e) => set({ folderId: e.target.value })}>
            <option value="">Unfiled</option>
            {folders.map((f) => <option key={f._id} value={f._id}>{f.name}</option>)}
          </select>
        </label>
        {draft.type === 'snippet' && (
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted">Language</span>
            <input className="field w-32 py-1" placeholder="e.g. ts" maxLength={40} value={draft.metadata.language ?? ''} onChange={(e) => setMeta({ language: e.target.value })} />
          </label>
        )}
      </div>

      <input autoFocus className="field font-serif text-xl" placeholder="Title" maxLength={200} value={draft.title} onChange={(e) => set({ title: e.target.value })} aria-label="Title" />

      {showSource && (
        <input className="field" type="url" placeholder="https://…" maxLength={2048} value={draft.sourceUrl} onChange={(e) => set({ sourceUrl: e.target.value })} aria-label="Source URL" />
      )}
      {draft.metadata.description !== undefined && (
        <textarea className="field min-h-16 text-sm" placeholder="Description" maxLength={1000} value={draft.metadata.description} onChange={(e) => setMeta({ description: e.target.value })} aria-label="Description" />
      )}

      <textarea
        className={`field min-h-48 leading-relaxed ${draft.type === 'snippet' ? 'font-mono text-sm' : 'font-serif'}`}
        placeholder={draft.type === 'snippet' ? 'Paste code…' : draft.type === 'url' ? 'Why is this link worth keeping?' : 'Write something…'}
        maxLength={50000}
        spellCheck={draft.type !== 'snippet'}
        value={draft.content}
        onChange={(e) => set({ content: e.target.value })}
        aria-label="Content"
      />
      <input className="field" placeholder="Tags, separated by commas" value={draft.tags} onChange={(e) => set({ tags: e.target.value })} aria-label="Tags" />

      <div className="flex items-center gap-2">
        <button className="btn-primary" onClick={onSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        <button className="btn-ghost" onClick={onCancel}>Cancel</button>
        <span className="ml-auto text-xs text-muted">Ctrl/⌘ + Enter to save · Esc to cancel</span>
      </div>
    </section>
  );
}
