import { Chunk } from '../../models/Chunk';
import { NoteVector } from '../../models/NoteVector';
import { keyPointsFor } from '../organize/key-points';
import { meanVector } from '../search/rank';
import { Note } from '../../models/Note';
import { ProcessingJob, type IProcessingJob } from '../../models/ProcessingJob';
import { embed, embeddingProvider, estimateTokens } from '../../platform/ai-client';
import { QUOTA_EXCEEDED } from '../../platform/quota';
import { chunkText } from './chunk';
import { extractText } from './extract';
import { MAX_ATTEMPTS, claimNext, queueIfChanged, retryDelayMs } from './jobs';

const EMBED_BATCH = 16;

type Job = IProcessingJob & { _id: unknown };
export type JobOutcome = 'ready' | 'stale' | 'gone' | 'retry' | 'failed';

/** What the user sees on the card when processing gives up. */
function userMessage(e: unknown): string {
  if ((e as { code?: string })?.code === QUOTA_EXCEEDED) return 'Daily AI budget reached. Use Retry tomorrow.';
  const msg = (e as Error)?.message ?? '';
  if (/timed out/i.test(msg)) return 'Processing timed out. Use Retry to try again.';
  if (/local embedding model/i.test(msg)) return 'The search model could not be loaded on the server.';
  return 'Could not prepare this item for search. Use Retry to try again.';
}

/** Marks the job finished only if no newer edit re-queued it while we worked. */
const settleJob = (job: Job, set: Record<string, unknown>) =>
  ProcessingJob.updateOne({ _id: job._id, status: 'processing', lockedAt: job.lockedAt, contentHash: job.contentHash }, { $set: set });

/** extract → clean → chunk → embed → replace the note's chunks. */
export async function runJob(job: Job): Promise<JobOutcome> {
  const note = await Note.findOne({ _id: job.noteId, userId: job.userId, deletedAt: null }).lean();
  if (!note) {
    await ProcessingJob.deleteOne({ _id: job._id });
    return 'gone';
  }
  if (note.contentHash !== job.contentHash) {
    // Normally an edit already re-queued this job with the new hash; make sure it is queued either way.
    await queueIfChanged(note, true, true);
    return 'stale';
  }

  // The worker's own writes never change the note's "updated" time: only the user's edits do.
  const current = { _id: note._id, contentHash: job.contentHash };
  await Note.updateOne(current, { $set: { processing: { status: 'processing', updatedAt: new Date(), error: null } } }, { timestamps: false });

  try {
    const provider = embeddingProvider();
    const text = await extractText(note);
    const pieces = chunkText(text, {
      maxTokens: provider.chunkTokens,
      overlapTokens: provider.chunkOverlapTokens,
      title: note.title,
    });

    const vectors: number[][] = [];
    let model = provider.model;
    let dims = provider.dims;
    for (let i = 0; i < pieces.length; i += EMBED_BATCH) {
      const res = await embed(pieces.slice(i, i + EMBED_BATCH), { userId: String(job.userId), purpose: 'index' });
      vectors.push(...res.vectors);
      ({ model, dims } = res);
    }
    // One vector for the whole note (average of its chunks), for related notes, suggestions and
    // duplicates; and, for long notes, a few of its own sentences as key points.
    const noteVector = pieces.length ? meanVector(vectors) : null;
    const keyPoints = noteVector ? await keyPointsFor(String(job.userId), text, noteVector) : [];

    // The note may have been edited or trashed while we embedded; only write for the version we processed.
    const still = await Note.exists({ ...current, deletedAt: null });
    if (!still) return 'stale';
    await Chunk.deleteMany({ noteId: note._id });
    if (pieces.length) {
      await Chunk.insertMany(
        pieces.map((text, index) => ({ userId: note.userId, noteId: note._id, index, text, embedding: vectors[index], model, dims, tokenCount: estimateTokens(text) }))
      );
      await NoteVector.updateOne({ noteId: note._id }, { $set: { userId: note.userId, embedding: noteVector, model, dims } }, { upsert: true });
    } else {
      await NoteVector.deleteOne({ noteId: note._id });
    }
    await Note.updateOne(current, { $set: { keyPoints, processing: { status: pieces.length ? 'ready' : 'skipped', updatedAt: new Date(), error: null } } }, { timestamps: false });
    await settleJob(job, { status: 'ready', lastError: null, lockedAt: null });
    return 'ready';
  } catch (e) {
    const lastError = String((e as Error)?.message ?? e).slice(0, 500);
    const quota = (e as { code?: string })?.code === QUOTA_EXCEEDED;
    if (!quota && job.attempts < MAX_ATTEMPTS) {
      await settleJob(job, { status: 'pending', lastError, lockedAt: null, runAfter: new Date(Date.now() + retryDelayMs(job.attempts)) });
      await Note.updateOne(current, { $set: { processing: { status: 'pending', updatedAt: new Date(), error: null } } }, { timestamps: false });
      return 'retry';
    }
    await settleJob(job, { status: 'failed', lastError, lockedAt: null });
    await Note.updateOne(current, { $set: { processing: { status: 'failed', updatedAt: new Date(), error: userMessage(e) } } }, { timestamps: false });
    return 'failed';
  }
}

/** Claims and runs one job; returns null when nothing is runnable. */
export async function runNext(now = new Date()): Promise<JobOutcome | null> {
  const job = await claimNext(now);
  return job ? runJob(job as Job) : null;
}

/** Runs every job that is runnable now (tests, scripts and the eval use this). */
export async function drain(now = new Date()) {
  const outcomes: JobOutcome[] = [];
  for (let outcome = await runNext(now); outcome; outcome = await runNext(now)) outcomes.push(outcome);
  return outcomes;
}
