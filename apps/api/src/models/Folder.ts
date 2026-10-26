import { InferSchemaType, Schema, model } from 'mongoose';

const folderSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    color: { type: String, default: null },
  },
  { timestamps: true }
);

// Folder names are unique per user, case-insensitively.
folderSchema.index({ userId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });

export type IFolder = InferSchemaType<typeof folderSchema>;
export const Folder = model('Folder', folderSchema);
