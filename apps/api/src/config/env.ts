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

    // Phase 3: embeddings and semantic search.
    // local = free on-device model (default), openai = OpenAI API, fake = deterministic test vectors.
    EMBEDDING_PROVIDER: z.enum(['local', 'openai', 'fake']).default('local'),
    OPENAI_API_KEY: z.string().optional(),
    // Overrides the provider's default model (openai: text-embedding-3-small).
    EMBEDDING_MODEL: z.string().optional(),
    // Per-user daily token budget across embedding and generation calls.
    AI_DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(200_000),
    // auto = Atlas Vector Search when the index is available, else in-memory cosine search.
    VECTOR_BACKEND: z.enum(['auto', 'atlas', 'memory']).default('auto'),

    // Phase 4: answers from notes. Claude when a key is set, else free "smart quotes" (no model).
    // `fake` is for tests only.
    ANTHROPIC_API_KEY: z.string().optional(),
    ANSWER_PROVIDER: z.enum(['anthropic', 'quotes', 'fake']).optional(),
    ANSWER_MODEL: z.string().default('claude-opus-5-5'),
  })
  .superRefine((e, ctx) => {
    if (e.FIREBASE_AUTH_EMULATOR_HOST && e.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', message: 'FIREBASE_AUTH_EMULATOR_HOST must not be set in production' });
    }
    if (!e.FIREBASE_AUTH_EMULATOR_HOST && (!e.FIREBASE_CLIENT_EMAIL || !e.FIREBASE_PRIVATE_KEY)) {
      ctx.addIssue({ code: 'custom', message: 'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are required' });
    }
    if (e.EMBEDDING_PROVIDER === 'openai' && !e.OPENAI_API_KEY) {
      ctx.addIssue({ code: 'custom', message: 'OPENAI_API_KEY is required when EMBEDDING_PROVIDER=openai' });
    }
    if (e.ANSWER_PROVIDER === 'fake' && e.NODE_ENV === 'production') {
      ctx.addIssue({ code: 'custom', message: 'ANSWER_PROVIDER=fake is for tests only; use quotes or anthropic in production' });
    }
    if (e.ANSWER_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: 'custom', message: 'ANTHROPIC_API_KEY is required when ANSWER_PROVIDER=anthropic' });
    }
  });

export const env = schema.parse(process.env);
