import { auth } from './firebase';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export const NOTE_TYPES = ['note', 'snippet', 'url', 'idea', 'document'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export const TYPE_LABELS: Record<NoteType, string> = { note: 'Notes', snippet: 'Snippets', url: 'Links', idea: 'Ideas', document: 'Documents' };

/** Fields the user can edit. */
export type EditableMetadata = { language?: string; siteName?: string; description?: string; author?: string };
export const EDITABLE_METADATA_KEYS = ['language', 'siteName', 'description', 'author'] as const;

/** Server-set fields for uploaded documents. */
export type NoteMetadata = EditableMetadata & {
  fileName?: string;
  fileSize?: number;
  mimeType?: string;
  pageCount?: number;
  truncated?: boolean;
};

export const UPLOAD_ACCEPT = '.txt,.md,.markdown,.pdf,.docx';
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export type Note = {
  _id: string;
  type: NoteType;
  title: string;
  content: string;
  tags: string[];
  folderId: string | null;
  sourceUrl: string | null;
  metadata: NoteMetadata;
  pinned: boolean;
  archived: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Search indexing state (Phase 3). Missing on items not processed yet. */
  processing?: { status: 'pending' | 'processing' | 'ready' | 'failed' | 'skipped'; updatedAt: string; error: string | null } | null;
};

export type NoteList = { items: Note[]; total: number; page: number; limit: number; matchMode: 'all' | 'text' | 'partial' };

export type SearchMode = 'keyword' | 'semantic' | 'hybrid';
export type MatchedBy = 'keyword' | 'meaning' | 'both';
export type SearchHit = { note: Note; score: number; snippet: string | null; matchedBy: MatchedBy };
export type SearchResults = { mode: SearchMode; items: SearchHit[]; warning?: string };

export const isIndexing = (n: Note) => n.processing?.status === 'pending' || n.processing?.status === 'processing';

export type Folder = { _id: string; name: string; color: string | null; noteCount: number };
export type FolderList = { folders: Folder[]; unfiledCount: number };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // FormData sets its own multipart Content-Type (with boundary).
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed (${res.status})`);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

/** Only render links the browser can't turn into script execution. */
export const safeHref = (url: string | null) => (url && /^https?:\/\//i.test(url) ? url : undefined);

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${+(n / 1024 / 1024).toFixed(1)} MB`;

export const hostOf =(url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};
