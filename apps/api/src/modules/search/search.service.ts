import { HttpError } from '../../middleware/errors';
import { Note, type INote } from '../../models/Note';
import { embed, embeddingProvider } from '../../platform/ai-client';
import { QUOTA_EXCEEDED } from '../../platform/quota';
import { listQuerySchema } from '../notes/notes.schema';
import { baseFilter, listNotes } from '../notes/notes.service';
import type { SearchQuery } from './search.schema';
import { isStrongKeywordHit, rrf } from './rank';
import { nearestChunks } from './vector-store';

type LeanNote = INote & { _id: unknown };
export type MatchedBy = 'keyword' | 'meaning' | 'both';
export type SearchHit = { note: LeanNote; score: number; snippet: string | null; matchedBy: MatchedBy };

const CANDIDATES = 50; // per ranking, before fusion
const SNIPPET_CHARS = 240;

/**
 * Below this cosine similarity a "meaning" match is noise. Tuned per model on the eval set
 * (apps/api/eval/search, docs/eval/phase3.md): for the local model 0.25 keeps 95% of paraphrase
 * matches with no off-topic results (0.15 lets noise in, 0.30 loses paraphrases).
 * OpenAI's value is a starting point; re-run the eval's sweep after switching.
 */
export const MIN_SIMILARITY: Record<string, number> = { local: 0.25, openai: 0.3, fake: 0.25 };
export const minSimilarity = () => MIN_SIMILARITY[embeddingProvider().name] ?? 0.3;

const activeFilter = (userId: string, q: SearchQuery) =>
  baseFilter(userId, listQuerySchema.parse({ view: 'active', type: q.type, folder: q.folder, tag: q.tag }));

function snippetOf(chunk: string, title: string) {
  const body = title && chunk.startsWith(title) ? chunk.slice(title.length) : chunk;
  const text = body.replace(/\s+/g, ' ').trim();
  return text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS).replace(/\s+\S*$/, '')}…` : text || null;
}

async function keywordRanking(userId: string, q: SearchQuery, limit: number): Promise<SearchHit[]> {
  const { items } = await listNotes(userId, listQuerySchema.parse({ q: q.q, view: 'active', type: q.type, folder: q.folder, tag: q.tag, sort: 'relevance', limit }));
  return items.map((note, i) => ({ note: note as LeanNote, score: 1 / (i + 1), snippet: null, matchedBy: 'keyword' }));
}

/** Embeds the query, finds the nearest chunks, and keeps each item's best chunk as its snippet. */
async function meaningRanking(userId: string, q: SearchQuery, limit: number): Promise<SearchHit[]> {
  const { vectors, model } = await embed([q.q], { userId, purpose: 'query' });
  const filtered = !!(q.type || q.folder || q.tag);
  const hits = await nearestChunks(userId, model, vectors[0], filtered ? limit * 6 : limit * 3);

  const minScore = minSimilarity();
  const best = new Map<string, { score: number; text: string }>();
  for (const h of hits) {
    if (h.score < minScore) continue;
    if (!best.has(h.noteId) || best.get(h.noteId)!.score < h.score) best.set(h.noteId, { score: h.score, text: h.text });
  }
  if (!best.size) return [];

  // Re-check ownership, trash/archive state and the list filters against the notes themselves.
  const notes = await Note.find({ ...activeFilter(userId, q), _id: { $in: [...best.keys()] } }).lean();
  return notes
    .map((note) => {
      const b = best.get(String(note._id))!;
      return { note: note as LeanNote, score: b.score, snippet: snippetOf(b.text, note.title), matchedBy: 'meaning' as const };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * How much each ranking counts in hybrid search (mutable only so the eval can sweep it).
 * Tuned on the eval set (docs/eval/phase3.md): with weak keyword hits filtered out, a meaning
 * weight of 1.5 lifts paraphrase MRR from 0.90 to 0.93 (same as meaning-only search) while
 * keyword-style queries stay at 100% / 1.00; higher weights add nothing.
 */
export const hybridWeights = { keyword: 1, meaning: 1.5 };

/** Hybrid ranking: weighted reciprocal-rank fusion of the keyword and meaning lists. */
function fuse(keyword: SearchHit[], meaning: SearchHit[]): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  for (const h of [...meaning, ...keyword]) if (!byId.has(String(h.note._id))) byId.set(String(h.note._id), h);
  const snippet = new Map(meaning.map((h) => [String(h.note._id), h.snippet]));
  const lists = [keyword.map((h) => String(h.note._id)), meaning.map((h) => String(h.note._id))];
  return rrf(lists, undefined, [hybridWeights.keyword, hybridWeights.meaning]).map(({ id, score, lists }) => ({
    note: byId.get(id)!.note,
    score,
    snippet: snippet.get(id) ?? null,
    matchedBy: lists.length > 1 ? 'both' : lists[0] === 0 ? 'keyword' : 'meaning',
  }));
}

const isQuota = (e: unknown) => (e as { code?: string })?.code === QUOTA_EXCEEDED;

export async function search(userId: string, q: SearchQuery) {
  if (q.mode === 'keyword') {
    return { mode: q.mode, items: await keywordRanking(userId, q, q.limit) };
  }

  if (q.mode === 'semantic') {
    try {
      return { mode: q.mode, items: await meaningRanking(userId, q, q.limit) };
    } catch (e) {
      if (isQuota(e)) throw e;
      console.error('Meaning search failed', e);
      throw new HttpError(503, 'Search by meaning is unavailable right now. Try keyword search.', 'SEMANTIC_UNAVAILABLE');
    }
  }

  // Hybrid degrades to keyword results (with a warning) rather than failing the whole search.
  const [keyword, meaning] = await Promise.all([
    keywordRanking(userId, q, CANDIDATES),
    meaningRanking(userId, q, CANDIDATES).catch((e: unknown) => {
      if (!isQuota(e)) console.error('Meaning search failed', e);
      return e;
    }),
  ]);
  if (!Array.isArray(meaning)) {
    const warning = isQuota(meaning) ? 'Daily AI budget reached; showing keyword matches only.' : 'Search by meaning is unavailable; showing keyword matches only.';
    return { mode: q.mode, items: keyword.slice(0, q.limit), warning };
  }
  // Keyword hits that match only an incidental word of the question would outrank real meaning
  // matches in the fusion; keep only those that cover a fair share of the query.
  const strongKeyword = keyword.filter(({ note: n }) =>
    isStrongKeywordHit(q.q, [n.title, n.content, n.tags.join(' '), n.metadata?.description, n.sourceUrl].filter(Boolean).join(' '))
  );
  return { mode: q.mode, items: fuse(strongKeyword, meaning).slice(0, q.limit) };
}
