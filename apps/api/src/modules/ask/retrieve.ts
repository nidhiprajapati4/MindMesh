import { Note } from '../../models/Note';
import { embed } from '../../platform/ai-client';
import { estimateTokens } from '../../platform/tokens';
import { listQuerySchema } from '../notes/notes.schema';
import { baseFilter } from '../notes/notes.service';
import { minSimilarity } from '../search/search.service';
import { nearestChunks, type VectorHit } from '../search/vector-store';
import { looksLikeFollowUp } from './follow-up';

export const MAX_SOURCE_NOTES = 8;
export const MAX_CHUNKS_PER_NOTE = 2;
/** Total size of the note passages sent to the answer model. */
export const CONTEXT_TOKEN_CAP = 6000;
const CANDIDATE_CHUNKS = 60;

export type RetrievedNote = { noteId: string; title: string; type: string; text: string; score: number };

/** Chunks start with the item's title (see chunk.ts); the answer model gets the title separately. */
const withoutTitle = (chunk: string, title: string) => (title && chunk.startsWith(title) ? chunk.slice(title.length) : chunk).trim();

/**
 * The user's notes most relevant to a question, best first, with their most relevant passages.
 *
 * A follow-up can't be understood alone, so it is also searched together with the previous
 * question. A self-contained question is searched as written; otherwise a change of topic
 * ("volcanic eruptions in Iceland" after questions about bread) would keep pulling in the old topic.
 */
export async function retrieveForQuestion(userId: string, question: string, previousQuestion?: string): Promise<RetrievedNote[]> {
  const queries = previousQuestion && looksLikeFollowUp(question) ? [question, `${previousQuestion}\n${question}`] : [question];
  const { vectors, model } = await embed(queries, { userId, purpose: 'query' });

  const threshold = minSimilarity();
  const byNote = new Map<string, VectorHit[]>();
  const seen = new Set<string>();
  for (const hits of await Promise.all(vectors.map((v) => nearestChunks(userId, model, v, CANDIDATE_CHUNKS)))) {
    for (const hit of hits) {
      const key = `${hit.noteId}\u0000${hit.text}`;
      if (hit.score < threshold || seen.has(key)) continue;
      seen.add(key);
      byNote.set(hit.noteId, [...(byNote.get(hit.noteId) ?? []), hit]);
    }
  }
  if (!byNote.size) return [];

  // Ownership, trash and archive are re-checked on the notes themselves, as in search.
  const active = baseFilter(userId, listQuerySchema.parse({ view: 'active' }));
  const notes = await Note.find({ ...active, _id: { $in: [...byNote.keys()] } }, { title: 1, type: 1 }).lean();

  const ranked = notes
    .map((n) => {
      const hits = byNote.get(String(n._id))!.sort((a, b) => b.score - a.score).slice(0, MAX_CHUNKS_PER_NOTE);
      return { note: n, hits, score: hits[0].score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_SOURCE_NOTES);

  const out: RetrievedNote[] = [];
  let budget = CONTEXT_TOKEN_CAP;
  for (const { note, hits, score } of ranked) {
    const passages: string[] = [];
    for (const h of hits) {
      const text = withoutTitle(h.text, note.title);
      const cost = estimateTokens(text);
      if (cost > budget) break;
      budget -= cost;
      passages.push(text);
    }
    if (!passages.length) break; // context is full; lower-ranked notes would not fit either
    out.push({ noteId: String(note._id), title: note.title || 'Untitled', type: note.type, text: passages.join('\n\n…\n\n'), score });
  }
  return out;
}
