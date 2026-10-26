import mongoose from 'mongoose';
import { Folder } from '../models/Folder';
import { Chunk } from '../models/Chunk';
import { Note } from '../models/Note';
import { ProcessingJob } from '../models/ProcessingJob';
import { Usage } from '../models/Usage';
import { backfill } from '../modules/ai-processing/jobs';
import { initVectorBackend } from '../modules/search/vector-store';
import { env } from './env';

export async function connectDb() {
  // Indexes are synced explicitly below so changed definitions (e.g. the Phase 2 text index)
  // replace the old ones instead of conflicting with them.
  mongoose.set('autoIndex', false);
  await mongoose.connect(env.MONGODB_URI);
  console.log('MongoDB connected');
  await migrate();
}

async function migrate() {
  // Phase 1 notes predate `type`, `folderId` and `deletedAt`.
  const { modifiedCount } = await Note.updateMany({ type: { $exists: false } }, { $set: { type: 'note', folderId: null, deletedAt: null } });
  if (modifiedCount) console.log(`Backfilled ${modifiedCount} notes to Phase 2 shape`);
  await Promise.all([Note.syncIndexes(), Folder.syncIndexes(), Chunk.syncIndexes(), ProcessingJob.syncIndexes(), Usage.syncIndexes()]);
  // Phase 3: notes saved before embeddings existed get queued once so they become searchable by meaning.
  const queued = await backfill({ processing: null });
  if (queued) console.log(`Queued ${queued} existing notes for embedding`);
  await initVectorBackend();
}
