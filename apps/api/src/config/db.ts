import mongoose from 'mongoose';
import { Folder } from '../models/Folder';
import { Note } from '../models/Note';
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
  await Promise.all([Note.syncIndexes(), Folder.syncIndexes()]);
}
