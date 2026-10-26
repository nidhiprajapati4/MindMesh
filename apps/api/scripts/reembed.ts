/**
 * Re-queues every live note for embedding and removes vectors from other models.
 * Run after changing EMBEDDING_PROVIDER or EMBEDDING_MODEL, with the worker running:
 *
 *   npm run reembed -w apps/api
 */
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db';
import { Chunk } from '../src/models/Chunk';
import { embeddingProvider } from '../src/platform/ai-client';
import { backfill } from '../src/modules/ai-processing/jobs';

async function main() {
  await connectDb(); // also updates the Atlas index if the vector size changed
  const { model } = embeddingProvider();
  const removed = await Chunk.deleteMany({ model: { $ne: model } });
  const queued = await backfill({});
  console.log(`Model ${model}: queued ${queued} notes, removed ${removed.deletedCount} chunks from other models.`);
  console.log('Start the worker (npm run worker -w apps/api) if it is not running.');
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
