import { InferSchemaType, Schema, model } from 'mongoose';

/**
 * One vector per note: the normalised average of its chunk embeddings, written by the worker.
 * Used to find similar notes (related notes, suggestions, duplicates). Never sent to the browser.
 */
const noteVectorSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    noteId: { type: Schema.Types.ObjectId, ref: 'Note', required: true },
    embedding: { type: [Number], required: true },
    // Vectors from different models are not comparable; similarity only uses the current model.
    model: { type: String, required: true },
    dims: { type: Number, required: true },
  },
  { timestamps: true }
);

noteVectorSchema.index({ noteId: 1 }, { unique: true });
noteVectorSchema.index({ userId: 1, model: 1 });
// Phase 6: the graph cache checks the user's latest vector update.
noteVectorSchema.index({ userId: 1, updatedAt: -1 });

export type INoteVector = InferSchemaType<typeof noteVectorSchema>;
export const NoteVector = model('NoteVector', noteVectorSchema, 'noteVectors');
