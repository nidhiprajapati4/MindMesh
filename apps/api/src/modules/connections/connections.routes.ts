import { Router } from 'express';
import { z } from 'zod';
import { NOTE_TYPES } from '../../models/Note';
import { objectId } from '../notes/notes.schema';
import * as connections from './connections.service';
import { buildGraph, libraryTopics } from './graph';

const router = Router();

// The notes this note links to, and the notes linking to it.
router.get('/links/:id', async (req, res) => {
  res.json(await connections.noteLinks(req.auth!.userId, objectId.parse(req.params.id)));
});

const graphQuery = z
  .object({
    folder: z.union([z.literal('none'), objectId]).optional(),
    tag: z.string().trim().toLowerCase().max(40).optional(),
    type: z.enum(NOTE_TYPES).optional(),
    // Include "similar meaning" connections (default) or only [[links]].
    similar: z.enum(['0', '1', 'true', 'false']).default('1').transform((v) => v === '1' || v === 'true'),
  })
  .strict();

// The notes and connections to draw in the graph view.
router.get('/graph', async (req, res) => {
  res.json(await buildGraph(req.auth!.userId, graphQuery.parse(req.query)));
});

// Topics found across the user's notes, and notes not connected to anything.
router.get('/topics', async (req, res) => {
  res.json(await libraryTopics(req.auth!.userId));
});

export default router;
