import { InferSchemaType, Schema, model } from 'mongoose';

/** Per-user daily AI usage counters (day = UTC date, YYYY-MM-DD). */
const usageSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    day: { type: String, required: true },
    embedTokens: { type: Number, default: 0 },
    genTokens: { type: Number, default: 0 },
    requests: { type: Number, default: 0 },
  },
  { timestamps: true }
);

usageSchema.index({ userId: 1, day: 1 }, { unique: true });
// Old counters are only useful for a while; drop them after 90 days.
usageSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export type IUsage = InferSchemaType<typeof usageSchema>;
export const Usage = model('Usage', usageSchema, 'usage');
