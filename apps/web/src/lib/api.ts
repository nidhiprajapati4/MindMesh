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
  /** 2–3 of the note's own sentences summarising it (long notes only, Phase 5). */
  keyPoints?: string[];
  /** [[links]] in the text (Phase 6); noteId is null while no note has that title. */
  outLinks?: { key: string; title: string; noteId: string | null }[];
  /** How many notes link to this one (notes list only, Phase 6). */
  backlinkCount?: number;
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

/** Sends a request to the API with the signed-in user's token; returns the raw response. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await auth.currentUser?.getIdToken();
  return fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // FormData sets its own multipart Content-Type (with boundary).
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
}

/** Error carrying the API's machine-readable `code` (e.g. QUOTA_EXCEEDED) when it sent one. */
export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.code);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

// --- Smart organization (Phase 5) -----------------------------------------------------------

export type NoteBrief = { _id: string; title: string; type: NoteType; preview: string };
export type RelatedNotes = { items: { note: NoteBrief; score: number }[]; pending: boolean };
export type Suggestions = {
  tags: { tag: string; score: number }[];
  folder: { _id: string; name: string; score: number } | null;
  duplicates: (NoteBrief & { score: number; reason: 'similar' | 'same-link' })[];
};
export type DuplicatePairs = {
  pairs: { a: NoteBrief; b: NoteBrief; score: number; reason: 'similar' | 'same-link' }[];
  scanned: number;
  capped: boolean;
};

// --- Ask your notes (Phase 4) ---------------------------------------------------------------

export type AnswerSource = { index: number; noteId: string; title: string; type?: NoteType };
export type TurnCitation = { source: number; quote: string };
export type TurnSegment = { text: string; citations: TurnCitation[] };
export type TurnStatus = 'complete' | 'not_found' | 'stopped' | 'error';
export type Turn = {
  question: string;
  segments: TurnSegment[];
  sources: { noteId: string; title: string }[];
  status: TurnStatus;
  error: string | null;
  feedback: { rating: 'up' | 'down' | null; comment: string };
  createdAt: string;
};
export type Conversation = { _id: string; title: string; turns: Turn[]; updatedAt: string };
export type ConversationSummary = { _id: string; title: string; updatedAt: string; turnCount: number };

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

// --- Connections (Phase 6) ------------------------------------------------------------------

export type NoteLinks = {
  outgoing: { title: string; note: NoteBrief | null; state: 'ok' | 'missing' | 'trashed' }[];
  backlinks: NoteBrief[];
};

/** How titles are compared for [[links]]; must match `titleKey` in the API. */
export const linkKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** Splits text into plain parts and [[link]] parts (the same syntax the API parses). */
export const LINK_RE = /\[\[([^[\]\n]{1,200})\]\]/g;

export type GraphNode = { id: string; title: string; type: NoteType; folderId: string | null; tags: string[]; topicId: string | null; degree: number };
export type GraphEdge = { source: string; target: string; kind: 'link' | 'similar'; similar: number | null };
export type GraphData = { nodes: GraphNode[]; edges: GraphEdge[]; capped: boolean; total: number };
export type TopicList = {
  topics: { id: string; name: string; noteIds: string[]; size: number }[];
  unconnected: { _id: string; title: string; type: NoteType }[];
  unconnectedCount: number;
  capped: boolean;
};
