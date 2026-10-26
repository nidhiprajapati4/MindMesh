import { Router } from 'express';
import { captureUrlSchema, createNoteSchema, listQuerySchema, objectId, updateNoteSchema } from './notes.schema';
import * as notes from './notes.service';

const router = Router();

const noteId = (id: string) => objectId.parse(id);

router.get('/tags', async (req, res) => {
  res.json(await notes.listTags(req.auth!.userId));
});

router.get('/', async (req, res) => {
  res.json(await notes.listNotes(req.auth!.userId, listQuerySchema.parse(req.query)));
});

router.post('/', async (req, res) => {
  res.status(201).json(await notes.createNote(req.auth!.userId, createNoteSchema.parse(req.body)));
});

router.post('/capture-url', async (req, res) => {
  res.status(201).json(await notes.captureUrl(req.auth!.userId, captureUrlSchema.parse(req.body)));
});

router.delete('/trash', async (req, res) => {
  res.json(await notes.emptyTrash(req.auth!.userId));
});

router.get('/:id', async (req, res) => {
  res.json(await notes.getNote(req.auth!.userId, noteId(req.params.id)));
});

router.patch('/:id', async (req, res) => {
  res.json(await notes.updateNote(req.auth!.userId, noteId(req.params.id), updateNoteSchema.parse(req.body)));
});

// Moves the note to the trash (recoverable for TRASH_RETENTION_DAYS).
router.delete('/:id', async (req, res) => {
  res.json(await notes.trashNote(req.auth!.userId, noteId(req.params.id)));
});

router.post('/:id/restore', async (req, res) => {
  res.json(await notes.restoreNote(req.auth!.userId, noteId(req.params.id)));
});

router.delete('/:id/permanent', async (req, res) => {
  await notes.destroyNote(req.auth!.userId, noteId(req.params.id));
  res.status(204).end();
});

export default router;
