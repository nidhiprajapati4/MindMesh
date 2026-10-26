import { InferSchemaType, Schema, model } from 'mongoose';

export const NOTE_TYPES = ['note', 'snippet', 'url', 'idea', 'document'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export const TRASH_RETENTION_DAYS = 30;

const metadataSchema = new Schema(
  {
    language: { type: String, trim: true, maxlength: 40 },
    siteName: { type: String, trim: true, maxlength: 200 },
    description: { type: String, trim: true, maxlength: 1000 },
    author: { type: String, trim: true, maxlength: 200 },
  },
  { _id: false, strict: true }
);

const noteSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    type: { type: String, enum: NOTE_TYPES, default: 'note' },
    title: { type: String, default: '', trim: true, maxlength: 200 },
    content: { type: String, default: '', maxlength: 50000 },
    tags: { type: [String], default: [] },
    folderId: { type: Schema.Types.ObjectId, ref: 'Folder', default: null },
    sourceUrl: { type: String, default: null, maxlength: 2048 },
    metadata: { type: metadataSchema, default: () => ({}) },
    pinned: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    // Soft delete: set when moved to trash; the TTL index purges after the retention window.
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

noteSchema.index(
  { title: 'text', content: 'text', tags: 'text', 'metadata.description': 'text' },
  { weights: { title: 10, tags: 5, 'metadata.description': 2, content: 1 }, name: 'note_text' }
);
noteSchema.index({ userId: 1, deletedAt: 1, archived: 1, pinned: -1, updatedAt: -1 });
noteSchema.index({ userId: 1, type: 1, updatedAt: -1 });
noteSchema.index({ userId: 1, folderId: 1, updatedAt: -1 });
noteSchema.index({ userId: 1, tags: 1 });
noteSchema.index({ deletedAt: 1 }, { expireAfterSeconds: TRASH_RETENTION_DAYS * 24 * 60 * 60 });

export type INote = InferSchemaType<typeof noteSchema>;
export const Note = model('Note', noteSchema);
