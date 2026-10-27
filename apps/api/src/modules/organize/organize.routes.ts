import { Router } from 'express';
import { z } from 'zod';
import { objectId } from '../notes/notes.schema';
import * as organize from './organize.service';

const router = Router();

// Notes most similar to this one.
router.get('/related/:id', async (req, res) => {
  res.json(await organize.relatedNotes(req.auth!.userId, objectId.parse(req.params.id)));
});

const suggestSchema = z
  .object({
    title: z.string().max(200).default(''),
    content: z.string().max(50000).default(''),
    sourceUrl: z.string().max(2048).nullable().optional(),
    tags: z.array(z.string().trim().toLowerCase().max(40)).max(20).default([]),
    folderId: objectId.nullable().optional(),
    // The note being edited, so it isn't suggested as its own duplicate.
    noteId: objectId.optional(),
  })
  .strict();

// Tag, folder and duplicate suggestions for a draft (new or being edited).
router.post('/suggest', async (req, res) => {
  res.json(await organize.suggestForDraft(req.auth!.userId, suggestSchema.parse(req.body)));
});

// Likely duplicate pairs among the user's recent notes.
router.get('/duplicates', async (req, res) => {
  res.json(await organize.duplicatePairs(req.auth!.userId));
});

export default router;
