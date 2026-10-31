import { isValidObjectId } from 'mongoose';
import { z } from 'zod';
import { NOTE_TYPES } from '../../models/Note';

export const objectId = z.string().refine(isValidObjectId, 'Invalid id');

const tags = z
  .array(z.string().trim().toLowerCase().min(1).max(40))
  .max(20)
  .transform((t) => [...new Set(t)]);

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine((u) => /^https?:\/\//i.test(u), 'Only http(s) URLs are allowed');

const metadata = z
  .object({
    language: z.string().trim().max(40),
    siteName: z.string().trim().max(200),
    description: z.string().trim().max(1000),
    author: z.string().trim().max(200),
  })
  .partial()
  .strict();

const noteFields = {
  type: z.enum(NOTE_TYPES),
  title: z.string().trim().max(200),
  content: z.string().max(50000),
  tags,
  folderId: objectId.nullable(),
  sourceUrl: httpUrl.nullable(),
  metadata,
  pinned: z.boolean(),
  favourite: z.boolean(),
  archived: z.boolean(),
};

export const createNoteSchema = z
  .object({
    ...noteFields,
    type: noteFields.type.default('note'),
    title: noteFields.title.default(''),
    content: noteFields.content.default(''),
    tags: tags.default([]),
    folderId: noteFields.folderId.default(null),
    sourceUrl: noteFields.sourceUrl.default(null),
    metadata: metadata.default({}),
    pinned: noteFields.pinned.default(false),
    favourite: noteFields.favourite.default(false),
    archived: noteFields.archived.default(false),
  })
  .strict();

export const updateNoteSchema = z.object(noteFields).partial().strict();

/** Multipart text fields that accompany an uploaded file. */
export const uploadFieldsSchema = z
  .object({
    folderId: z.preprocess((v) => (v === '' ? null : v), objectId.nullable().default(null)),
    tags: z
      .string()
      .max(1000)
      .default('')
      .transform((s) => s.split(',').map((t) => t.trim()).filter(Boolean))
      .pipe(tags),
  })
  .strict();

export const captureUrlSchema = z
  .object({
    url: httpUrl,
    folderId: objectId.nullable().default(null),
    tags: tags.default([]),
  })
  .strict();

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

export const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().toLowerCase().optional(),
  type: z.enum(NOTE_TYPES).optional(),
  // 'none' = items not in any folder
  folder: z.union([z.literal('none'), objectId]).optional(),
  pinned: bool.optional(),
  favourite: bool.optional(),
  view: z.enum(['active', 'archived', 'trash']).default('active'),
  // Phase 1 compatibility: ?archived=true maps to view=archived
  archived: bool.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  sort: z.enum(['updated', 'created', 'title', 'relevance']).default('updated'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateNoteInput = z.infer<typeof createNoteSchema>;
export type UpdateNoteInput = z.infer<typeof updateNoteSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
