import { auth } from './firebase';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export const NOTE_TYPES = ['note', 'snippet', 'url', 'idea', 'document'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];
export const TYPE_LABELS: Record<NoteType, string> = { note: 'Notes', snippet: 'Snippets', url: 'Links', idea: 'Ideas', document: 'Documents' };

export type NoteMetadata = { language?: string; siteName?: string; description?: string; author?: string };

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
};

export type NoteList = { items: Note[]; total: number; page: number; limit: number; matchMode: 'all' | 'text' | 'partial' };

export type Folder = { _id: string; name: string; color: string | null; noteCount: number };
export type FolderList = { folders: Folder[]; unfiledCount: number };

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
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

export const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};
