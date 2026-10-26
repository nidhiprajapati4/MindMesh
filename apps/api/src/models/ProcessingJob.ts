import { InferSchemaType, Schema, model } from 'mongoose';

export const JOB_STATUSES = ['pending', 'processing', 'ready', 'failed'] as const;

/** MongoDB-backed work queue (ADR-008): one embed job per note, claimed atomically by the worker. */
const jobSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    noteId: { type: Schema.Types.ObjectId, ref: 'Note', required: true },
    kind: { type: String, enum: ['embed'], default: 'embed' },
    status: { type: String, enum: JOB_STATUSES, default: 'pending' },
    // Hash of the note content this job was queued for; stale results are discarded.
    contentHash: { type: String, required: true },
    attempts: { type: Number, default: 0 },
    lastError: { type: String, default: null },
    runAfter: { type: Date, default: () => new Date() },
    // Set when claimed; a job stuck in `processing` past the lock timeout is reclaimed.
    lockedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

jobSchema.index({ noteId: 1, kind: 1 }, { unique: true });
jobSchema.index({ status: 1, runAfter: 1 });

export type IProcessingJob = InferSchemaType<typeof jobSchema>;
export const ProcessingJob = model('ProcessingJob', jobSchema, 'processingJobs');
