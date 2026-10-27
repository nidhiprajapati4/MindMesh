import { Types } from 'mongoose';
import { env } from '../../config/env';
import { Chunk } from '../../models/Chunk';
import { NoteVector } from '../../models/NoteVector';
import { embeddingProvider } from '../../platform/ai-client';
import { cosine, topK } from './rank';
import { log } from '../../platform/logger';

export const VECTOR_INDEX = 'chunk_vector_index';
export const NOTE_VECTOR_INDEX = 'note_vector_index';

export type VectorHit = { noteId: string; text: string; score: number };
export type NoteHit = { noteId: string; score: number };

let backend: 'atlas' | 'memory' = 'memory';
export const vectorBackend = () => backend;

/** The Atlas Vector Search index on chunks (same shape as apps/api/atlas/vector-index.json). */
export const vectorIndexDefinition = (dims: number) => ({
  fields: [
    { type: 'vector', path: 'embedding', numDimensions: dims, similarity: 'cosine' },
    { type: 'filter', path: 'userId' },
    { type: 'filter', path: 'model' },
  ],
});

/** Creates the vector index on a collection if missing, or updates it when its shape changed. */
async function ensureVectorIndex(m: typeof Chunk | typeof NoteVector, name: string, definition: ReturnType<typeof vectorIndexDefinition>) {
  // Search indexes need the collection to exist.
  await m.createCollection().catch(() => undefined);
  const coll = m.collection;
  type IndexField = { type: string; path?: string; numDimensions?: number };
  const [existing] = (await coll.listSearchIndexes(name).toArray()) as { latestDefinition?: { fields?: IndexField[] } }[];
  if (!existing) {
    await coll.createSearchIndex({ name, type: 'vectorSearch', definition });
    log.info('atlas_index_created', { index: name, note: 'queryable within a minute or two' });
    return;
  }
  const fields = existing.latestDefinition?.fields ?? [];
  const dims = fields.find((f) => f.type === 'vector')?.numDimensions;
  if (dims !== definition.fields[0].numDimensions || !fields.some((f) => f.path === 'model')) {
    await coll.updateSearchIndex(name, definition);
    log.info('atlas_index_updated', { index: name });
  }
}

/**
 * Picks the search backend at startup. For `atlas`/`auto` it creates the vector index if missing
 * (or updates it when the embedding size changed). `auto` falls back to in-memory search when the
 * server has no Atlas Search (e.g. a local or in-memory MongoDB).
 */
export async function initVectorBackend() {
  if (env.VECTOR_BACKEND === 'memory') {
    backend = 'memory';
    return backend;
  }
  try {
    const definition = vectorIndexDefinition(embeddingProvider().dims);
    await ensureVectorIndex(Chunk, VECTOR_INDEX, definition);
    await ensureVectorIndex(NoteVector, NOTE_VECTOR_INDEX, definition);
    backend = 'atlas';
  } catch (e) {
    if (env.VECTOR_BACKEND === 'atlas') throw e;
    backend = 'memory';
    log.warn('atlas_vector_search_unavailable', { reason: (e as Error).message, fallback: 'in-memory search' });
  }
  return backend;
}

/** The user's k nearest chunks by cosine similarity (scores in [-1, 1], higher is closer). */
export async function nearestChunks(userId: string, model: string, queryVector: number[], k: number): Promise<VectorHit[]> {
  if (backend === 'atlas') {
    const rows = await Chunk.aggregate<{ noteId: Types.ObjectId; text: string; score: number }>([
      {
        $vectorSearch: {
          index: VECTOR_INDEX,
          path: 'embedding',
          queryVector,
          numCandidates: Math.max(100, k * 10),
          limit: k,
          filter: { userId: new Types.ObjectId(userId), model },
        },
      },
      { $project: { _id: 0, noteId: 1, text: 1, score: { $meta: 'vectorSearchScore' } } },
    ]);
    // Atlas reports cosine as (1 + cos) / 2; convert back so both backends use the same scale.
    return rows.map((r) => ({ noteId: String(r.noteId), text: r.text, score: 2 * r.score - 1 }));
  }

  // Fallback for servers without Atlas Search: fine for a few thousand chunks per user.
  const chunks = await Chunk.find({ userId, model }, { noteId: 1, text: 1, embedding: 1 }).lean();
  return topK(
    chunks.map((c) => ({ noteId: String(c.noteId), text: c.text, score: cosine(queryVector, c.embedding) })),
    k
  );
}

/** The user's k most similar notes to `vector`, by their note vectors (scores in [-1, 1]). */
export async function nearestNotes(userId: string, model: string, vector: number[], k: number): Promise<NoteHit[]> {
  if (backend === 'atlas') {
    const rows = await NoteVector.aggregate<{ noteId: Types.ObjectId; score: number }>([
      {
        $vectorSearch: {
          index: NOTE_VECTOR_INDEX,
          path: 'embedding',
          queryVector: vector,
          numCandidates: Math.max(100, k * 10),
          limit: k,
          filter: { userId: new Types.ObjectId(userId), model },
        },
      },
      { $project: { _id: 0, noteId: 1, score: { $meta: 'vectorSearchScore' } } },
    ]);
    return rows.map((r) => ({ noteId: String(r.noteId), score: 2 * r.score - 1 }));
  }
  const all = await NoteVector.find({ userId, model }, { noteId: 1, embedding: 1 }).lean();
  return topK(all.map((v) => ({ noteId: String(v.noteId), score: cosine(vector, v.embedding) })), k);
}

/** A note's own vector, if it has been processed with the current model. */
export async function noteVectorOf(userId: string, noteId: string, model: string): Promise<number[] | null> {
  const v = await NoteVector.findOne({ userId, noteId, model }, { embedding: 1 }).lean();
  return v?.embedding ?? null;
}
