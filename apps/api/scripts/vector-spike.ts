/**
 * ADR-007 go/no-go: does this Atlas cluster support Vector Search with a userId filter?
 * Creates a vector index on a scratch collection, inserts 3 vectors, runs $vectorSearch
 * filtered by userId, prints PASS/FAIL and always drops the scratch collection.
 *
 *   npm run spike:vector -w apps/api
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const COLLECTION = '_vector_spike';
const INDEX = 'spike_vector_index';
const DIMS = 4;

async function waitQueryable(coll: mongoose.mongo.Collection, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [idx] = await coll.listSearchIndexes(INDEX).toArray();
    if (idx?.queryable) return;
    if (idx?.status === 'FAILED') throw new Error(`Index build failed: ${JSON.stringify(idx)}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error('Index did not become queryable in time');
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(uri);
  const db = mongoose.connection.db!;
  const coll = db.collection(COLLECTION);
  let ok = false;
  try {
    await coll.insertMany([
      { userId: 'alice', text: 'retry with backoff', embedding: [1, 0, 0, 0] },
      { userId: 'alice', text: 'quarterly revenue', embedding: [0, 1, 0, 0] },
      { userId: 'bob', text: 'bob retry note', embedding: [0.99, 0.01, 0, 0] },
    ]);
    console.log('Creating vectorSearch index (Atlas builds it asynchronously)…');
    await coll.createSearchIndex({
      name: INDEX,
      type: 'vectorSearch',
      definition: {
        fields: [
          { type: 'vector', path: 'embedding', numDimensions: DIMS, similarity: 'cosine' },
          { type: 'filter', path: 'userId' },
        ],
      },
    });
    await waitQueryable(coll);
    // Newly indexed documents can take a moment to become visible.
    let results: any[] = [];
    for (let i = 0; i < 10 && results.length === 0; i++) {
      results = await coll
        .aggregate([
          { $vectorSearch: { index: INDEX, path: 'embedding', queryVector: [1, 0.05, 0, 0], numCandidates: 10, limit: 5, filter: { userId: 'alice' } } },
          { $project: { _id: 0, userId: 1, text: 1, score: { $meta: 'vectorSearchScore' } } },
        ])
        .toArray();
      if (!results.length) await new Promise((r) => setTimeout(r, 2000));
    }
    console.log('Results:', results);
    ok = results.length === 2 && results.every((r) => r.userId === 'alice') && results[0].text === 'retry with backoff';
  } catch (e) {
    console.error('Spike error:', (e as Error).message);
  } finally {
    await coll.drop().catch(() => undefined); // drops its search index too
    await mongoose.disconnect();
  }
  console.log(ok ? 'PASS: Atlas Vector Search with userId filter works' : 'FAIL: use VECTOR_BACKEND=memory');
  process.exit(ok ? 0 : 1);
}

void main();
