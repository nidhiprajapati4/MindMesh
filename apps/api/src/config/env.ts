import 'dotenv/config';
import { z } from 'zod';

const schema = z
  .object({
    NODE_ENV: z.string().default('development'),
    PORT: z.coerce.number().default(4000),
    CLIENT_ORIGIN: z.string().default('http://localhost:3000'),
    MONGODB_URI: z.string().min(1),
    FIREBASE_PROJECT_ID: z.string().min(1),
    FIREBASE_CLIENT_EMAIL: z.string().optional(),
    FIREBASE_PRIVATE_KEY: z.string().optional(),
    // Local testing only: when set, the Admin SDK verifies tokens from the Firebase Auth emulator.
    FIREBASE_AUTH_EMULATOR_HOST: z.string().optional(),
  })
  .superRefine((e, ctx) => {
    if (e.FIREBASE_AUTH_EMULATOR_HOST && e.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', message: 'FIREBASE_AUTH_EMULATOR_HOST must not be set in production' });
    }
    if (!e.FIREBASE_AUTH_EMULATOR_HOST && (!e.FIREBASE_CLIENT_EMAIL || !e.FIREBASE_PRIVATE_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are required' });
    }
  });

export const env = schema.parse(process.env);
