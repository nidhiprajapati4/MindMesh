'use client';

import { useEffect, useRef, useState, type DragEvent } from 'react';
import {
  MAX_UPLOAD_BYTES,
  NOTE_TYPES,
  UPLOAD_ACCEPT,
  formatBytes,
  type EditableMetadata,
  type Folder,
  type NoteMetadata,
  type NoteType,
} from '@/lib/api';

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
  error: string;
  onChange: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  onUpload: (file: File, folderId: string, tags: string) => Promise<void>;
  initialMode?: 'write' | 'upload';
};

const SINGULAR: Record<NoteType, string> = { note: 'Note', snippet: 'Snippet', url: 'Link', idea: 'Idea', document: 'Document' };
const ALLOWED_EXT = UPLOAD_ACCEPT.split(',');

/** Client-side pre-check; the server re-validates everything. */
export function checkUploadFile(file: File): string {
  const ext = /\.[^.]+$/.exec(file.name.toLowerCase())?.[0] ?? '';
  if (!ALLOWED_EXT.includes(ext)) return `Unsupported file type. Allowed: ${ALLOWED_EXT.join(', ')}`;
  if (file.size > MAX_UPLOAD_BYTES) return `File is too large (max ${formatBytes(MAX_UPLOAD_BYTES)})`;
  if (!file.size) return 'The file is empty';
  return '';
}

export function NoteEditor({ draft, folders, saving, error, onChange, onSave, onCancel, onUpload, initialMode = 'write' }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [initial] = useState(() => JSON.stringify(draft));
  const [mode, setMode] = useState<'write' | 'upload'>(draft.id ? 'write' : initialMode);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [dragging, setDragging] = useState(false);

  const isNew = !draft.id;
  const dirty = mode === 'upload' ? !!file : JSON.stringify(draft) !== initial;
  const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });
  const setMeta = (patch: EditableMetadata) => set({ metadata: { ...draft.metadata, ...patch } });
  const showSource = draft.type === 'url' || (draft.type === 'document' && !draft.metadata.fileName) || !!draft.sourceUrl;
  const fileInfo = draft.metadata.fileName ? draft.metadata : null;

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (!d.open) d.showModal();
    // showModal() focuses the first focusable element (the close button); move focus to the main field.
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    // Safety net: if the browser closes the dialog by itself (e.g. Chrome ignores a repeated
    // cancel), reopen it so it never ends up invisible while the editor is still active.
    let unmounting = false;
    const onClose = () => {
      if (!unmounting) d.showModal();
    };
    d.addEventListener('close', onClose);
    return () => {
      unmounting = true;
      d.removeEventListener('close', onClose);
      d.close();
    };
  }, []);

  const requestClose = () => {
    if (saving) return;
    if (dirty && !confirm('Discard your changes?')) return;
    onCancel();
  };

  const pickFile = (f: File | undefined) => {
    if (!f) return;
    const problem = checkUploadFile(f);
    setFileError(problem);
    setFile(problem ? null : f);
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    pickFile(e.dataTransfer.files[0]);
  };

  const submit = () => {
    if (mode === 'upload') {
      if (file) void onUpload(file, draft.folderId, draft.tags);
      else setFileError('Choose a file to upload');
    } else onSave();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="editor-title"
      className="w-[min(46rem,calc(100vw-2rem))] rounded-lg border border-line bg-white p-0 text-ink shadow-2xl backdrop:bg-ink/40"
      onCancel={(e) => {
        e.preventDefault(); // Esc is handled in onKeyDown; never let the browser close it directly
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          // Handling Esc here (instead of the cancel event) works every time; Chrome only lets a
          // page block `cancel` once per user interaction.
          e.preventDefault();
          requestClose();
        } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      <div className="flex max-h-[min(90vh,52rem)] flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3">
          <h2 id="editor-title" className="font-serif text-xl font-semibold">{isNew ? 'New item' : `Edit ${SINGULAR[draft.type].toLowerCase()}`}</h2>
          <button className="rounded px-2 py-1 text-xl leading-none text-muted hover:bg-paper" onClick={requestClose} aria-label="Close">×</button>
        </header>

        <div className="flex flex-col gap-3 overflow-y-auto px-5 py-4">
          {isNew && (
            <div role="tablist" aria-label="How to add" className="flex gap-1 self-start rounded border border-line bg-paper p-1 text-sm">
              {(['write', 'upload'] as const).map((m) => (
                <button key={m} role="tab" aria-selected={mode === m} onClick={() => setMode(m)}
                  className={`rounded px-3 py-1 ${mode === m ? 'bg-white font-medium shadow-sm' : 'text-muted'}`}>
                  {m === 'write' ? 'Write' : 'Upload file'}
                </button>
              ))}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {mode === 'write' && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted">Type</span>
                <select className="field w-auto py-1" value={draft.type} onChange={(e) => set({ type: e.target.value as NoteType })}>
                  {NOTE_TYPES.map((t) => <option key={t} value={t}>{SINGULAR[t]}</option>)}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <span className="text-muted">Folder</span>
              <select className="field w-auto py-1" value={draft.folderId} onChange={(e) => set({ folderId: e.target.value })}>
                <option value="">Unfiled</option>
                {folders.map((f) => <option key={f._id} value={f._id}>{f.name}</option>)}
              </select>
            </label>
            {mode === 'write' && draft.type === 'snippet' && (
              <label className="flex items-center gap-2 text-sm">
                <span className="text-muted">Language</span>
                <input className="field w-32 py-1" placeholder="e.g. ts" maxLength={40} value={draft.metadata.language ?? ''} onChange={(e) => setMeta({ language: e.target.value })} />
              </label>
            )}
          </div>

          {mode === 'upload' ? (
            <>
              <div
                onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                onDragLeave={() => setDragging(false)}
                onDrop={onDrop}
                className={`flex flex-col items-center gap-2 rounded border-2 border-dashed px-4 py-8 text-center text-sm ${dragging ? 'border-accent bg-paper' : 'border-line'}`}
              >
                {file ? (
                  <p><span className="font-medium">{file.name}</span> <span className="text-muted">· {formatBytes(file.size)}</span></p>
                ) : (
                  <p className="text-muted">Drag a file here, or</p>
                )}
                <button type="button" data-autofocus className="btn-ghost" onClick={() => fileRef.current?.click()}>{file ? 'Choose a different file' : 'Choose file'}</button>
                <input ref={fileRef} type="file" accept={UPLOAD_ACCEPT} className="sr-only" aria-label="File to upload" tabIndex={-1}
                  onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }} />
                <p className="text-xs text-muted">PDF, Word (.docx), Markdown or plain text · up to 10 MB. The text is extracted into a new document item; the file itself is not stored.</p>
              </div>
              {fileError && <p role="alert" className="text-sm text-red-700">{fileError}</p>}
            </>
          ) : (
            <>
              <input data-autofocus className="field font-serif text-xl" placeholder="Title" maxLength={200} value={draft.title} onChange={(e) => set({ title: e.target.value })} aria-label="Title" />

              {fileInfo && (
                <p className="rounded bg-paper px-3 py-2 text-xs text-muted">
                  From file <span className="font-medium text-ink">{fileInfo.fileName}</span>
                  {fileInfo.fileSize !== undefined && ` · ${formatBytes(fileInfo.fileSize)}`}
                  {fileInfo.pageCount ? ` · ${fileInfo.pageCount} page${fileInfo.pageCount === 1 ? '' : 's'}` : ''}
                  {fileInfo.truncated && ' · text was cut off at 50,000 characters'}
                </p>
              )}
              {showSource && (
                <input className="field" type="url" placeholder="https://…" maxLength={2048} value={draft.sourceUrl} onChange={(e) => set({ sourceUrl: e.target.value })} aria-label="Source URL" />
              )}
              {draft.metadata.description !== undefined && (
                <textarea className="field min-h-16 text-sm" placeholder="Description" maxLength={1000} value={draft.metadata.description} onChange={(e) => setMeta({ description: e.target.value })} aria-label="Description" />
              )}

              <textarea
                className={`field min-h-56 leading-relaxed ${draft.type === 'snippet' ? 'font-mono text-sm' : 'font-serif'}`}
                placeholder={draft.type === 'snippet' ? 'Paste code…' : draft.type === 'url' ? 'Why is this link worth keeping?' : 'Write something…'}
                maxLength={50000}
                spellCheck={draft.type !== 'snippet'}
                value={draft.content}
                onChange={(e) => set({ content: e.target.value })}
                aria-label="Content"
              />
            </>
          )}

          <input className="field" placeholder="Tags, separated by commas" value={draft.tags} onChange={(e) => set({ tags: e.target.value })} aria-label="Tags" />
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        </div>

        <footer className="flex items-center gap-2 border-t border-line px-5 py-3">
          <button className="btn-primary" onClick={submit} disabled={saving}>
            {saving ? (mode === 'upload' ? 'Uploading…' : 'Saving…') : mode === 'upload' ? 'Upload' : 'Save'}
          </button>
          <button className="btn-ghost" onClick={requestClose} disabled={saving}>Cancel</button>
          <span className="ml-auto hidden text-xs text-muted sm:inline">Ctrl/⌘ + Enter to save · Esc to close</span>
        </footer>
      </div>
    </dialog>
  );
}
