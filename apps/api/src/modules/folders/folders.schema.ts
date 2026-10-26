import { z } from 'zod';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must be a hex value like #0F6E7A');

export const createFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    color: color.nullable().default(null),
  })
  .strict();

export const updateFolderSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    color: color.nullable(),
  })
  .partial()
  .strict();
