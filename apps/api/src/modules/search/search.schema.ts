import { z } from 'zod';
import { NOTE_TYPES } from '../../models/Note';
import { objectId } from '../notes/notes.schema';

export const SEARCH_MODES = ['keyword', 'semantic', 'hybrid'] as const;

export const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'Enter something to search for').max(200),
  mode: z.enum(SEARCH_MODES).default('hybrid'),
  type: z.enum(NOTE_TYPES).optional(),
  folder: z.union([z.literal('none'), objectId]).optional(),
  tag: z.string().trim().toLowerCase().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchMode = (typeof SEARCH_MODES)[number];
