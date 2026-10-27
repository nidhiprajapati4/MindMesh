import { Types } from 'mongoose';
import { HttpError } from '../../middleware/errors';
import { Folder } from '../../models/Folder';
import { Note } from '../../models/Note';
import { NoteVector } from '../../models/NoteVector';
import { embed, embeddingProvider } from '../../platform/ai-client';
import { chunkText } from '../ai-processing/chunk';
import { listQuerySchema } from '../notes/notes.schema';
import { baseFilter } from '../notes/notes.service';
import { cosine, meanVector } from '../search/rank';
import { nearestNotes, noteVectorOf } from '../search/vector-store';

/**
 * Similarity cut-offs (cosine, local MiniLM model). Mutable only so the eval can sweep them;
 * the sweeps behind each value are in docs/eval/phase5.md.
 */
export const organizeSettings = {
  /** A note is "related" above this similarity. 0.35 roughly doubled how many notes show related
   *  notes compared with 0.45, at the best same-topic share; 0.30 let unrelated notes in. */
  relatedMin: 0.35,
  /** A neighbour's tags (and folder) only count if it is at least this similar. With several notes
   *  per topic, 0.35 suggested the right tag for 63% of notes with no wrong ones; on a library of
   *  one-off topics it stayed silent instead of guessing. 0.30 started suggesting wrong folders. */
  tagNeighbourMin: 0.35,
  /** A tag is suggested if this many neighbours use it… (1 made wrong suggestions: 14–50% precision) */
  tagMinVotes: 2,
  /** …or a single neighbour this similar uses it. */
  tagStrongSim: 0.7,
  /** A folder is suggested when neighbours holding this share of the vote weight agree on it. */
  folderMinShare: 0.6,
  /** Notes at least this similar are flagged as possible duplicates: 0.90 caught all 8 reworded
   *  copies in the eval; 0.92 missed 2. */
  duplicateMin: 0.9,
};

export const MAX_RELATED = 5;
const NEIGHBOURS = 10;
const MAX_TAG_SUGGESTIONS = 3;
const MAX_DUPLICATE_SCAN = 1500;
const MAX_DUPLICATE_PAIRS = 50;
const MIN_DRAFT_CHARS = 20;
/** Long drafts are embedded like the worker does (chunks, then averaged), capped to stay quick. */
const MAX_DRAFT_CHUNKS = 8;

const activeFilter = (userId: string) => baseFilter(userId, listQuerySchema.parse({ view: 'active' }));

const preview = (n: { content?: string | null; metadata?: { description?: string | null } | null }) =>
  (n.content || n.metadata?.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);

type Brief = { _id: string; title: string; type: string; preview: string };
const brief = (n: { _id: unknown; title: string; type: string; content?: string | null; metadata?: { description?: string | null } | null }): Brief => ({
  _id: String(n._id),
  title: n.title || 'Untitled',
  type: n.type,
  preview: preview(n),
});

// --- Related notes --------------------------------------------------------------------------

export async function relatedNotes(userId: string, noteId: string) {
  const note = await Note.findOne({ _id: noteId, userId, deletedAt: null }, { _id: 1 }).lean();
  if (!note) throw new HttpError(404, 'Note not found');
  const { model } = embeddingProvider();
  const vector = await noteVectorOf(userId, noteId, model);
  if (!vector) return { items: [], pending: true }; // not processed yet

  const hits = (await nearestNotes(userId, model, vector, MAX_RELATED * 3 + 1)).filter(
    (h) => h.noteId !== noteId && h.score >= organizeSettings.relatedMin
  );
  const notes = await Note.find({ ...activeFilter(userId), _id: { $in: hits.map((h) => h.noteId) } }, { title: 1, type: 1, content: 1, 'metadata.description': 1 }).lean();
  const byId = new Map(notes.map((n) => [String(n._id), n]));
  const items = hits
    .filter((h) => byId.has(h.noteId))
    .slice(0, MAX_RELATED)
    .map((h) => ({ note: brief(byId.get(h.noteId)!), score: +h.score.toFixed(3) }));
  return { items, pending: false };
}

// --- Suggestions for a draft (tags, folder, duplicates) -------------------------------------

export type DraftInput = { title: string; content: string; sourceUrl?: string | null; tags: string[]; folderId?: string | null; noteId?: string };

/** Embeds a draft the way the worker embeds a saved note: title-prefixed chunks, averaged. */
async function draftVector(userId: string, d: DraftInput) {
  const p = embeddingProvider();
  const pieces = chunkText(d.content, { maxTokens: p.chunkTokens, overlapTokens: p.chunkOverlapTokens, title: d.title }).slice(0, MAX_DRAFT_CHUNKS);
  const { vectors, model } = await embed(pieces.length ? pieces : [d.title], { userId, purpose: 'query' });
  return { vector: meanVector(vectors), model };
}

const normaliseUrl = (u: string) => {
  try {
    const url = new URL(u);
    url.hash = '';
    return `${url.host.replace(/^www\./, '')}${url.pathname.replace(/\/$/, '')}${url.search}`.toLowerCase();
  } catch {
    return u.trim().toLowerCase();
  }
};

export async function suggestForDraft(userId: string, d: DraftInput) {
  const empty = { tags: [] as { tag: string; score: number }[], folder: null as null | { _id: string; name: string; score: number }, duplicates: [] as (Brief & { score: number; reason: 'similar' | 'same-link' })[] };
  const text = `${d.title} ${d.content}`.trim();

  // Same link saved before: a duplicate whatever the text says.
  if (d.sourceUrl) {
    const key = normaliseUrl(d.sourceUrl);
    const sameLink = await Note.find({ ...activeFilter(userId), sourceUrl: { $ne: null }, ...(d.noteId ? { _id: { $ne: d.noteId } } : {}) }, { title: 1, type: 1, content: 1, sourceUrl: 1, 'metadata.description': 1 }).lean();
    for (const n of sameLink) if (n.sourceUrl && normaliseUrl(n.sourceUrl) === key) empty.duplicates.push({ ...brief(n), score: 1, reason: 'same-link' });
  }
  if (text.length < MIN_DRAFT_CHARS) return empty;

  const { vector, model } = await draftVector(userId, d);
  const hits = (await nearestNotes(userId, model, vector, NEIGHBOURS + 1)).filter((h) => h.noteId !== d.noteId);
  const notes = await Note.find({ ...activeFilter(userId), _id: { $in: hits.map((h) => h.noteId) } }, { title: 1, type: 1, tags: 1, folderId: 1, content: 1, 'metadata.description': 1 }).lean();
  const byId = new Map(notes.map((n) => [String(n._id), n]));
  const neighbours = hits.filter((h) => byId.has(h.noteId)).slice(0, NEIGHBOURS).map((h) => ({ ...h, note: byId.get(h.noteId)! }));
  const s = organizeSettings;

  // Tags: similarity-weighted votes from close neighbours.
  const has = new Set(d.tags.map((t) => t.toLowerCase()));
  const votes = new Map<string, { weight: number; count: number; best: number }>();
  for (const n of neighbours) {
    if (n.score < s.tagNeighbourMin) continue;
    for (const tag of n.note.tags) {
      if (has.has(tag)) continue;
      const v = votes.get(tag) ?? { weight: 0, count: 0, best: 0 };
      votes.set(tag, { weight: v.weight + n.score, count: v.count + 1, best: Math.max(v.best, n.score) });
    }
  }
  const tags = [...votes.entries()]
    .filter(([, v]) => v.count >= s.tagMinVotes || v.best >= s.tagStrongSim)
    .sort((a, b) => b[1].weight - a[1].weight)
    .slice(0, MAX_TAG_SUGGESTIONS)
    .map(([tag, v]) => ({ tag, score: +v.weight.toFixed(3) }));

  // Folder: only for unfiled drafts, when close *filed* neighbours clearly agree. Unfiled notes
  // don't vote: they're usually just not organised yet, not a choice for "no folder".
  let folder: typeof empty.folder = null;
  if (!d.folderId) {
    const filed = neighbours.filter((n) => n.score >= s.tagNeighbourMin && n.note.folderId);
    const total = filed.reduce((sum, n) => sum + n.score, 0);
    const byFolder = new Map<string, { weight: number; count: number }>();
    for (const n of filed) {
      const f = String(n.note.folderId);
      const v = byFolder.get(f) ?? { weight: 0, count: 0 };
      byFolder.set(f, { weight: v.weight + n.score, count: v.count + 1 });
    }
    const [topId, top] = [...byFolder.entries()].sort((a, b) => b[1].weight - a[1].weight)[0] ?? [];
    if (topId && top.count >= 2 && top.weight / total >= s.folderMinShare) {
      const f = await Folder.findOne({ _id: topId, userId }, { name: 1 }).lean();
      if (f) folder = { _id: topId, name: f.name, score: +(top.weight / total).toFixed(3) };
    }
  }

  const duplicates = [
    ...empty.duplicates,
    ...neighbours
      .filter((n) => n.score >= s.duplicateMin && !empty.duplicates.some((x) => x._id === n.noteId))
      .map((n) => ({ ...brief(n.note), score: +n.score.toFixed(3), reason: 'similar' as const })),
  ];
  return { tags, folder, duplicates };
}

// --- Possible duplicates across the user's notes ---------------------------------------------

export async function duplicatePairs(userId: string) {
  const { model } = embeddingProvider();
  const notes = await Note.find(activeFilter(userId), { title: 1, type: 1, content: 1, sourceUrl: 1, 'metadata.description': 1 })
    .sort({ updatedAt: -1 })
    .limit(MAX_DUPLICATE_SCAN)
    .lean();
  const ids = notes.map((n) => n._id);
  const vectors = await NoteVector.find({ userId: new Types.ObjectId(userId), model, noteId: { $in: ids } }, { noteId: 1, embedding: 1 }).lean();
  const vec = new Map(vectors.map((v) => [String(v.noteId), v.embedding]));

  const pairs: { a: Brief; b: Brief; score: number; reason: 'similar' | 'same-link' }[] = [];
  const seen = new Set<string>();
  const add = (i: number, j: number, score: number, reason: 'similar' | 'same-link') => {
    const key = [String(notes[i]._id), String(notes[j]._id)].sort().join(':');
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ a: brief(notes[i]), b: brief(notes[j]), score: +score.toFixed(3), reason });
  };

  const byLink = new Map<string, number[]>();
  notes.forEach((n, i) => n.sourceUrl && byLink.set(normaliseUrl(n.sourceUrl), [...(byLink.get(normaliseUrl(n.sourceUrl)) ?? []), i]));
  for (const group of byLink.values()) for (let x = 0; x < group.length; x++) for (let y = x + 1; y < group.length; y++) add(group[x], group[y], 1, 'same-link');

  for (let i = 0; i < notes.length; i++) {
    const vi = vec.get(String(notes[i]._id));
    if (!vi) continue;
    for (let j = i + 1; j < notes.length; j++) {
      const vj = vec.get(String(notes[j]._id));
      if (!vj) continue;
      const score = cosine(vi, vj);
      if (score >= organizeSettings.duplicateMin) add(i, j, score, 'similar');
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return { pairs: pairs.slice(0, MAX_DUPLICATE_PAIRS), scanned: notes.length, capped: notes.length >= MAX_DUPLICATE_SCAN };
}
