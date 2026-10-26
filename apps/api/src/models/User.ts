import { InferSchemaType, Schema, model } from 'mongoose';

const userSchema = new Schema(
  {
    firebaseUid: { type: String, required: true, unique: true, index: true },
    email: { type: String, default: '' },
    displayName: { type: String, default: '' },
    photoURL: { type: String, default: '' },
  },
  { timestamps: true }
);

export type IUser = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
