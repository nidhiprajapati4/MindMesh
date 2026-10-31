import { InferSchemaType, Schema, model } from 'mongoose';

const userSchema = new Schema(
  {
    firebaseUid: { type: String, required: true, unique: true, index: true },
    email: { type: String, default: '' },
    displayName: { type: String, default: '' },
    photoURL: { type: String, default: '' },
    // Optional profile details the user can add on the Profile page. Older accounts have none.
    phone: { type: String, default: '', maxlength: 30 },
    dob: { type: Date, default: null },
    birthLocation: { type: String, default: '', maxlength: 100 },
  },
  { timestamps: true }
);

export type IUser = InferSchemaType<typeof userSchema>;
export const User = model('User', userSchema);
