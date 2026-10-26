import { Types } from 'mongoose';
import { env } from '../../config/env';
import { Chunk } from '../../models/Chunk';
import { embeddingProvider } from '../../platform/ai-client';
import { cosine, topK } from './rank';

export const VECTOR_INDEX = 'chunk_vector_index';

export type VectorHit = { noteId: string; text: string; score: number };

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
    const coll = Chunk.collection;
    const definition = vectorIndexDefinition(embeddingProvider().dims);
    // Search indexes need the collection to exist.
    await Chunk.createCollection().catch(() => undefined);
    type IndexField = { type: string; path?: string; numDimensions?: number };
    const [existing] = (await coll.listSearchIndexes(VECTOR_INDEX).toArray()) as { latestDefinition?: { fields?: IndexField[] } }[];
    if (!existing) {
      await coll.createSearchIndex({ name: VECTOR_INDEX, type: 'vectorSearch', definition });
      console.log('Created Atlas vector index (it becomes queryable within a minute or two)');
    } else {
      const fields = existing.latestDefinition?.fields ?? [];
      const dims = fields.find((f) => f.type === 'vector')?.numDimensions;
      if (dims !== definition.fields[0].numDimensions || !fields.some((f) => f.path === 'model')) {
        await coll.updateSearchIndex(VECTOR_INDEX, definition);
        console.log('Updated Atlas vector index definition');
      }
    }
    backend = 'atlas';
  } catch (e) {
    if (env.VECTOR_BACKEND === 'atlas') throw e;
    backend = 'memory';
    if (env.NODE_ENV !== 'test') console.log(`Atlas Vector Search unavailable (${(e as Error).message}); using in-memory search`);
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
