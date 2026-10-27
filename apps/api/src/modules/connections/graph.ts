import { Types } from 'mongoose';
import { Note } from '../../models/Note';
import { NoteVector } from '../../models/NoteVector';
import { embeddingProvider } from '../../platform/ai-client';
import { activeFilter } from '../notes/note-brief';
import { similarPairs } from '../search/rank';
import { topicsFor } from './topics';

/** Mutable only so the eval can sweep them; the sweeps are in docs/eval/phase6.md. */
export const graphSettings = {
  /** Two notes get a "similar" connection at or above this similarity… 0.40 connected 95% of
   *  known-subject notes to their subject with 3% unrelated lines; 0.45 connected only 76%. */
  similarMin: 0.4,
  /** …if the other note is among each one's most similar few (keeps the graph readable). */
  similarPerNote: 3,
};

/** Notes drawn in the graph at once (most recently updated first). */
export const MAX_GRAPH_NOTES = 500;
/** Notes compared for similar connections and topics. */
export const MAX_LIBRARY_NOTES = 1500;
/** Lowest similarity any setting may use; pairs below it are never kept. */
const PAIR_FLOOR = 0.3;
const CACHE_USERS = 100;

export type LibNote = { id: string; title: string; type: string; folderId: string | null; tags: string[]; linksTo: string[] };
export type Pair = { i: number; j: number; score: number };
/** The user's active notes, their links, and every pair of them at least PAIR_FLOOR similar. */
export type Library = { notes: LibNote[]; index: Map<string, number>; pairs: Pair[]; capped: boolean };

const cache = new Map<string, { key: string; lib: Library }>();

/** Builds a library from notes and their vectors (also used by the eval). */
export function makeLibrary(notes: LibNote[], vectors: Map<string, number[]>, capped = false): Library {
  return {
    notes,
    index: new Map(notes.map((n, i) => [n.id, i])),
    pairs: similarPairs(notes.map((n) => vectors.get(n.id)), PAIR_FLOOR),
    capped,
  };
}

/**
 * The user's library, rebuilt only when a note was added, edited or removed (the active note count
 * or latest edit time changes) or processed (the note vectors' count or latest update changes).
 */
export async function loadLibrary(userId: string): Promise<Library> {
  const filter = activeFilter(userId);
  const owner = { userId: new Types.ObjectId(userId) };
  const [latest, count, latestVector, vectors] = await Promise.all([
    Note.findOne(filter, { updatedAt: 1 }).sort({ updatedAt: -1 }).lean(),
    Note.countDocuments(filter),
    NoteVector.findOne(owner, { updatedAt: 1 }).sort({ updatedAt: -1 }).lean(),
    NoteVector.countDocuments(owner),
  ]);
  const key = `${count}:${latest?.updatedAt?.getTime() ?? 0}:${vectors}:${latestVector?.updatedAt?.getTime() ?? 0}`;
  const hit = cache.get(userId);
  if (hit?.key === key) return hit.lib;

  const docs = await Note.find(filter, { title: 1, type: 1, folderId: 1, tags: 1, 'outLinks.noteId': 1 })
    .sort({ updatedAt: -1 })
    .limit(MAX_LIBRARY_NOTES)
    .lean();
  const notes: LibNote[] = docs.map((n) => ({
    id: String(n._id),
    title: n.title || 'Untitled',
    type: n.type,
    folderId: n.folderId ? String(n.folderId) : null,
    tags: n.tags,
    linksTo: n.outLinks.filter((l) => l.noteId).map((l) => String(l.noteId)),
  }));
  const rows = await NoteVector.find(
    { userId: new Types.ObjectId(userId), model: embeddingProvider().model, noteId: { $in: docs.map((d) => d._id) } },
    { noteId: 1, embedding: 1 }
  ).lean();
  const lib = makeLibrary(notes, new Map(rows.map((r) => [String(r.noteId), r.embedding])), count > MAX_LIBRARY_NOTES);

  cache.delete(userId);
  cache.set(userId, { key, lib });
  if (cache.size > CACHE_USERS) cache.delete(cache.keys().next().value!);
  return lib;
}

/**
 * Similar connections among `included` notes: each note keeps its few most similar notes at or
 * above the threshold; a pair is connected if either note keeps the other.
 */
export function similarityEdges(lib: Library, included: Set<number>, min = graphSettings.similarMin, perNote = graphSettings.similarPerNote) {
  const best = new Map<number, Pair[]>();
  for (const p of lib.pairs) {
    if (p.score < min || !included.has(p.i) || !included.has(p.j)) continue;
    for (const k of [p.i, p.j]) best.set(k, [...(best.get(k) ?? []), p]);
  }
  const kept = new Map<string, Pair>();
  for (const list of best.values()) {
    for (const p of list.sort((a, b) => b.score - a.score).slice(0, perNote)) kept.set(`${p.i}:${p.j}`, p);
  }
  return [...kept.values()];
}

export type GraphQuery = { folder?: string; tag?: string; type?: string; similar: boolean };
export type GraphEdge = { source: string; target: string; kind: 'link' | 'similar'; similar: number | null };

const matches = (n: LibNote, q: GraphQuery) =>
  (!q.folder || (q.folder === 'none' ? n.folderId === null : n.folderId === q.folder)) &&
  (!q.tag || n.tags.includes(q.tag)) &&
  (!q.type || n.type === q.type);

/**
 * The notes to draw and their connections: links written as [[Title]] and, optionally, similar
 * meaning. A pair that is both is one link edge carrying its similarity.
 */
export async function buildGraph(userId: string, q: GraphQuery) {
  const lib = await loadLibrary(userId);
  const topicOf = new Map(topicsFor(lib).topics.flatMap((t) => t.noteIds.map((id) => [id, t.id] as const)));
  const all = lib.notes.flatMap((n, i) => (matches(n, q) ? [i] : []));
  const shown = all.slice(0, MAX_GRAPH_NOTES);
  const included = new Set(shown);

  const edges = new Map<string, GraphEdge>();
  const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);
  for (const i of shown) {
    for (const target of lib.notes[i].linksTo) {
      const j = lib.index.get(target);
      if (j === undefined || j === i || !included.has(j) || edges.has(pairKey(i, j))) continue;
      edges.set(pairKey(i, j), { source: lib.notes[i].id, target, kind: 'link', similar: null });
    }
  }
  if (q.similar) {
    for (const p of similarityEdges(lib, included)) {
      const score = +p.score.toFixed(3);
      const existing = edges.get(pairKey(p.i, p.j));
      if (existing) existing.similar = score;
      else edges.set(pairKey(p.i, p.j), { source: lib.notes[p.i].id, target: lib.notes[p.j].id, kind: 'similar', similar: score });
    }
  }

  const degree = new Map<string, number>();
  for (const e of edges.values()) for (const id of [e.source, e.target]) degree.set(id, (degree.get(id) ?? 0) + 1);
  const nodes = shown.map((i) => {
    const n = lib.notes[i];
    return { id: n.id, title: n.title, type: n.type, folderId: n.folderId, tags: n.tags, topicId: topicOf.get(n.id) ?? null, degree: degree.get(n.id) ?? 0 };
  });
  return { nodes, edges: [...edges.values()], capped: all.length > shown.length || lib.capped, total: all.length };
}

export const MAX_UNCONNECTED = 100;

/** Topics across the library, and notes not connected to anything (good ones to link, tag or delete). */
export async function libraryTopics(userId: string) {
  const lib = await loadLibrary(userId);
  const { topics, unconnected } = topicsFor(lib);
  return {
    topics: topics.map((t) => ({ ...t, size: t.noteIds.length })),
    unconnected: unconnected.slice(0, MAX_UNCONNECTED).map((n) => ({ _id: n.id, title: n.title, type: n.type })),
    unconnectedCount: unconnected.length,
    capped: lib.capped,
  };
}
