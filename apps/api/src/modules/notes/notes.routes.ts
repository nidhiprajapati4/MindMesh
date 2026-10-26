import { Router } from 'express';
import multer from 'multer';
import { HttpError } from '../../middleware/errors';
import { reprocess } from '../ai-processing/jobs';
import { MAX_UPLOAD_BYTES } from './file-extract';
import { captureUrlSchema, createNoteSchema, listQuerySchema, objectId, updateNoteSchema, uploadFieldsSchema } from './notes.schema';
import * as notes from './notes.service';

const router = Router();

// Files are kept in memory only long enough to extract their text; nothing is written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5, fieldSize: 2000 },
  defParamCharset: 'utf8',
});

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

router.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) throw new HttpError(400, 'Attach a file in the "file" field');
  const fields = uploadFieldsSchema.parse(req.body ?? {});
  res.status(201).json(await notes.uploadDocument(req.auth!.userId, req.file, fields));
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

// Re-queues embedding for this item (the card's Retry button after a failure).
router.post('/:id/reprocess', async (req, res) => {
  const note = await reprocess(req.auth!.userId, noteId(req.params.id));
  if (!note) throw new HttpError(404, 'Note not found');
  res.json(note);
});

router.delete('/:id/permanent', async (req, res) => {
  await notes.destroyNote(req.auth!.userId, noteId(req.params.id));
  res.status(204).end();
});

export default router;
