import { InferSchemaType, Schema, model } from 'mongoose';

/**
 * A slice of an item's text and its embedding. Searched with Atlas Vector Search
 * (index definition: apps/api/atlas/vector-index.json) or in memory as a fallback.
 */
const chunkSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    noteId: { type: Schema.Types.ObjectId, ref: 'Note', required: true },
    index: { type: Number, required: true },
    text: { type: String, required: true },
    embedding: { type: [Number], required: true },
    // Vectors from different models are not comparable; search filters on the current model.
    model: { type: String, required: true },
    dims: { type: Number, required: true },
    tokenCount: { type: Number, required: true },
  },
  { timestamps: true }
);

chunkSchema.index({ noteId: 1, index: 1 });
chunkSchema.index({ userId: 1, model: 1 });

export type IChunk = InferSchemaType<typeof chunkSchema>;
export const Chunk = model('Chunk', chunkSchema);
