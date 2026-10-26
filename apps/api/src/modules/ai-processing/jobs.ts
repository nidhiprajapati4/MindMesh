import type { Types } from 'mongoose';
import { Chunk } from '../../models/Chunk';
import { Note } from '../../models/Note';
import { ProcessingJob } from '../../models/ProcessingJob';
import { contentHash, hasSearchableText } from './extract';

export const MAX_ATTEMPTS = 3;
export const LOCK_TIMEOUT_MS = 5 * 60_000;
export const RETRY_BASE_MS = 10_000;

type Id = Types.ObjectId | string;
type QueueableNote = Parameters<typeof contentHash>[0] & { _id: Id; userId: Id; contentHash?: string | null; processing?: unknown };

/** Delay before re-running a job that failed `attempts` times: 10 s, 20 s, 40 s … */
export const retryDelayMs = (attempts: number) => RETRY_BASE_MS * 2 ** (attempts - 1);

/**
 * Queues an embed job when the note's searchable content changed (or it was never processed).
 * Returns the fields written to the note, or null when nothing changed.
 */
export async function queueIfChanged(note: QueueableNote, force = false) {
  const hash = contentHash(note);
  if (!force && note.contentHash === hash && note.processing) return null;

  if (!hasSearchableText(note)) {
    const set = { contentHash: hash, processing: { status: 'skipped', updatedAt: new Date(), error: null } };
    await Promise.all([
      Note.updateOne({ _id: note._id }, { $set: set }),
      ProcessingJob.deleteOne({ noteId: note._id }),
      Chunk.deleteMany({ noteId: note._id }),
    ]);
    return set;
  }

  const set = { contentHash: hash, processing: { status: 'pending', updatedAt: new Date(), error: null } };
  await Note.updateOne({ _id: note._id }, { $set: set });
  // Upsert resets a running or failed job; the worker notices the new hash and discards its stale result.
  await ProcessingJob.updateOne(
    { noteId: note._id, kind: 'embed' },
    { $set: { userId: note.userId, status: 'pending', contentHash: hash, attempts: 0, lastError: null, runAfter: new Date(), lockedAt: null } },
    { upsert: true }
  );
  return set;
}

/** Removes a note's chunks and job (trash / permanent delete). */
export async function dropEmbeddings(noteIds: Id[]) {
  if (!noteIds.length) return;
  await Promise.all([Chunk.deleteMany({ noteId: { $in: noteIds } }), ProcessingJob.deleteMany({ noteId: { $in: noteIds } })]);
}

/**
 * Atomically claims the next runnable job: a pending one whose time has come, or one stuck
 * in `processing` longer than the lock timeout (its worker crashed). Several workers can run safely.
 */
export function claimNext(now = new Date()) {
  return ProcessingJob.findOneAndUpdate(
    {
      $or: [
        { status: 'pending', runAfter: { $lte: now } },
        { status: 'processing', lockedAt: { $lt: new Date(now.getTime() - LOCK_TIMEOUT_MS) } },
      ],
    },
    { $set: { status: 'processing', lockedAt: now }, $inc: { attempts: 1 } },
    { sort: { runAfter: 1 }, new: true }
  ).lean();
}

/** Owner-scoped "try again" for the card's Retry button. */
export async function reprocess(userId: string, noteId: string) {
  const note = await Note.findOne({ _id: noteId, userId, deletedAt: null }).lean();
  if (!note) return null;
  const set = await queueIfChanged(note, true);
  return { ...note, ...set };
}

/** Queues every live note that was never processed (Phase 2 data, or after a model switch). */
export async function backfill(filter: Record<string, unknown> = { processing: null }) {
  let queued = 0;
  for await (const note of Note.find({ deletedAt: null, ...filter }).lean().cursor()) {
    if (await queueIfChanged(note, true)) queued++;
  }
  return queued;
}
