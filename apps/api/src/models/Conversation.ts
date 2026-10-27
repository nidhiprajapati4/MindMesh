import { InferSchemaType, Schema, model } from 'mongoose';

export const MAX_TURNS = 50;
export const TURN_STATUSES = ['complete', 'not_found', 'stopped', 'error'] as const;

const sourceSchema = new Schema({ noteId: { type: Schema.Types.ObjectId, ref: 'Note', required: true }, title: { type: String, default: '' } }, { _id: false });

// `source` is the index into the turn's `sources` (citation chips are numbered by it).
const citationSchema = new Schema({ source: { type: Number, required: true }, quote: { type: String, default: '' } }, { _id: false });

const segmentSchema = new Schema({ text: { type: String, default: '' }, citations: { type: [citationSchema], default: [] } }, { _id: false });

const turnSchema = new Schema(
  {
    question: { type: String, required: true, maxlength: 1000 },
    segments: { type: [segmentSchema], default: [] },
    sources: { type: [sourceSchema], default: [] },
    status: { type: String, enum: TURN_STATUSES, required: true },
    // Friendly reason when status is `error`.
    error: { type: String, default: null },
    feedback: {
      rating: { type: String, enum: ['up', 'down', null], default: null },
      comment: { type: String, default: '', maxlength: 1000 },
    },
    model: { type: String, default: null },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    costUsd: { type: Number, default: 0 },
    createdAt: { type: Date, default: () => new Date() },
  },
  { _id: false }
);

/** A thread of questions asked about the user's notes, with the answers and their citations. */
const conversationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, default: 'New conversation', trim: true, maxlength: 120 },
    turns: { type: [turnSchema], default: [] },
  },
  { timestamps: true, minimize: false }
);

conversationSchema.index({ userId: 1, updatedAt: -1 });

export type IConversation = InferSchemaType<typeof conversationSchema>;
export type ITurn = InferSchemaType<typeof turnSchema>;
export const Conversation = model('Conversation', conversationSchema);
