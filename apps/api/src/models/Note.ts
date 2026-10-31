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
    // Set by the server for uploaded documents; not editable by the client.
    fileName: { type: String, trim: true, maxlength: 255 },
    fileSize: { type: Number, min: 0 },
    mimeType: { type: String, maxlength: 100 },
    pageCount: { type: Number, min: 0 },
    truncated: { type: Boolean },
  },
  { _id: false, strict: true }
);

export const PROCESSING_STATUSES = ['pending', 'processing', 'ready', 'failed', 'skipped'] as const;

// Embedding status shown on cards. `skipped` = nothing to embed (empty item).
const processingSchema = new Schema(
  {
    status: { type: String, enum: PROCESSING_STATUSES, required: true },
    updatedAt: { type: Date, default: () => new Date() },
    error: { type: String, default: null },
  },
  { _id: false }
);

/** How a title is compared for [[links]]: case, spacing and Unicode form don't matter. */
export const titleKey = (title: string) => title.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

const outLinkSchema = new Schema(
  {
    key: { type: String, required: true },
    // The link text as written, for showing links to notes that don't exist (yet).
    title: { type: String, required: true },
    noteId: { type: Schema.Types.ObjectId, ref: 'Note', default: null },
  },
  { _id: false }
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
    // Starred by the user (separate from pinned). Older notes have no value, which reads as false.
    favourite: { type: Boolean, default: false },
    archived: { type: Boolean, default: false },
    // Soft delete: set when moved to trash; the TTL index purges after the retention window.
    deletedAt: { type: Date, default: null },
    // Phase 3: sha256 of the searchable text; unchanged content is never re-embedded.
    contentHash: { type: String, default: null },
    processing: { type: processingSchema, default: null },
    // Phase 5: 2–3 of the note's own sentences that summarise it (long notes only), set by the worker.
    keyPoints: { type: [String], default: [] },
    // Phase 6: normalised title, so [[links]] match case- and spacing-insensitively. Set by the hooks below.
    titleKey: { type: String, default: '' },
    // Phase 6: [[links]] written in the content. noteId is null while no note has that title.
    outLinks: { type: [outLinkSchema], default: [] },
  },
  // minimize: false keeps `metadata: {}` in responses instead of dropping the empty object.
  { timestamps: true, minimize: false }
);

noteSchema.index(
  { title: 'text', content: 'text', tags: 'text', 'metadata.description': 'text' },
  {
    weights: { title: 10, tags: 5, 'metadata.description': 2, content: 1 },
    name: 'note_text_v2',
    // MongoDB treats any field called `language` as the text-search language, which breaks
    // snippets (metadata.language = "ts"). Point the override at a field we never set.
    language_override: 'textSearchLanguage',
  }
);
noteSchema.index({ userId: 1, deletedAt: 1, archived: 1, pinned: -1, updatedAt: -1 });
noteSchema.index({ userId: 1, type: 1, updatedAt: -1 });
noteSchema.index({ userId: 1, folderId: 1, updatedAt: -1 });
noteSchema.index({ userId: 1, tags: 1 });
noteSchema.index({ deletedAt: 1 }, { expireAfterSeconds: TRASH_RETENTION_DAYS * 24 * 60 * 60 });
noteSchema.index({ userId: 1, titleKey: 1 });
noteSchema.index({ userId: 1, 'outLinks.noteId': 1 });

// Keep titleKey in step with title on every write path.
noteSchema.pre('save', function () {
  if (this.isModified('title') || this.isNew) this.titleKey = titleKey(this.title);
});
noteSchema.pre('insertMany', function (next: () => void, docs: { title?: string; titleKey?: string }[]) {
  for (const d of docs) d.titleKey = titleKey(d.title ?? '');
  next();
});
noteSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function () {
  const update = this.getUpdate() as { $set?: { title?: string }; title?: string } | null;
  const title = update?.$set?.title ?? update?.title;
  if (typeof title === 'string') this.setUpdate({ ...update, $set: { ...update!.$set, titleKey: titleKey(title) } });
});

export type INote = InferSchemaType<typeof noteSchema>;
export const Note = model('Note', noteSchema);
