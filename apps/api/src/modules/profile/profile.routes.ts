import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../middleware/errors';
import { User } from '../../models/User';

const router = Router();

/** Digits with an optional leading +, spaces, dashes and brackets: "+91 98765-43210". Empty clears it. */
const phone = z
  .string()
  .trim()
  .max(30)
  .refine((v) => v === '' || (/^\+?[0-9 ()-]{6,30}$/.test(v) && v.replace(/\D/g, '').length >= 6), 'Enter a valid phone number, e.g. +91 98765 43210');

/** A calendar date (YYYY-MM-DD), not in the future. Empty clears it. */
const dob = z
  .string()
  .trim()
  .refine((v) => v === '' || (/^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v))), 'Enter a valid date of birth')
  .refine((v) => v === '' || Date.parse(v) <= Date.now(), 'Date of birth can’t be in the future')
  .refine((v) => v === '' || Date.parse(v) >= Date.parse('1900-01-01'), 'Enter a valid date of birth');

// Email is not in this list on purpose, and `.strict()` rejects it: it comes from the sign-in
// account and can't be changed here, whichever way the user signs in.
const updateProfileSchema = z
  .object({
    displayName: z.string().trim().max(100),
    phone,
    dob,
    birthLocation: z.string().trim().max(100),
  })
  .partial()
  .strict();

type UserDoc = { email?: string | null; displayName?: string | null; photoURL?: string | null; phone?: string | null; dob?: Date | null; birthLocation?: string | null };
const present = (u: UserDoc) => ({
  email: u.email ?? '',
  displayName: u.displayName ?? '',
  photoURL: u.photoURL ?? '',
  phone: u.phone ?? '',
  dob: u.dob ? u.dob.toISOString().slice(0, 10) : '',
  birthLocation: u.birthLocation ?? '',
});

router.get('/', async (req, res) => {
  const user = await User.findById(req.auth!.userId).lean();
  if (!user) throw new HttpError(404, 'Profile not found');
  res.json(present(user));
});

router.patch('/', async (req, res) => {
  const input = updateProfileSchema.parse(req.body);
  const { dob: dobText, ...rest } = input;
  const $set: Record<string, unknown> = { ...rest };
  if (dobText !== undefined) $set.dob = dobText === '' ? null : new Date(`${dobText}T00:00:00.000Z`);
  const user = await User.findByIdAndUpdate(req.auth!.userId, { $set }, { new: true, runValidators: true }).lean();
  if (!user) throw new HttpError(404, 'Profile not found');
  res.json(present(user));
});

export default router;
