import { InferSchemaType, Schema, model } from 'mongoose';

export const MAX_SAVED_ANSWERS = 500;

const sourceSchema = new Schema({ noteId: { type: Schema.Types.ObjectId, ref: 'Note', required: true }, title: { type: String, default: '' } }, { _id: false });
const citationSchema = new Schema({ source: { type: Number, required: true }, quote: { type: String, default: '' } }, { _id: false });
const segmentSchema = new Schema({ text: { type: String, default: '' }, citations: { type: [citationSchema], default: [] } }, { _id: false });

/**
 * A question and answer the user bookmarked on the Ask page. It is a copy, so it stays readable
 * after the conversation it came from is renamed or deleted.
 */
const savedAnswerSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    turnIndex: { type: Number, required: true, min: 0 },
    question: { type: String, required: true, maxlength: 1000 },
    segments: { type: [segmentSchema], default: [] },
    sources: { type: [sourceSchema], default: [] },
  },
  { timestamps: true }
);

// One bookmark per answer: saving it twice is the same as saving it once.
savedAnswerSchema.index({ userId: 1, conversationId: 1, turnIndex: 1 }, { unique: true });
savedAnswerSchema.index({ userId: 1, createdAt: -1 });

export type ISavedAnswer = InferSchemaType<typeof savedAnswerSchema>;
export const SavedAnswer = model('SavedAnswer', savedAnswerSchema);
