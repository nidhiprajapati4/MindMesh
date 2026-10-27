import { z } from 'zod';
import { objectId } from '../notes/notes.schema';

export const askSchema = z
  .object({
    question: z.string().trim().min(1, 'Ask a question').max(1000),
    conversationId: objectId.optional(),
  })
  .strict();

export const renameConversationSchema = z.object({ title: z.string().trim().min(1).max(120) }).strict();

export const feedbackSchema = z
  .object({
    rating: z.enum(['up', 'down']).nullable(),
    comment: z.string().trim().max(1000).default(''),
  })
  .strict();

export type AskInput = z.infer<typeof askSchema>;
