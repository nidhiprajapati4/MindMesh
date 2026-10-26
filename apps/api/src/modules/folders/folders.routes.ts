import { Router } from 'express';
import { objectId } from '../notes/notes.schema';
import { createFolderSchema, updateFolderSchema } from './folders.schema';
import * as folders from './folders.service';

const router = Router();

router.get('/', async (req, res) => {
  res.json(await folders.listFolders(req.auth!.userId));
});

router.post('/', async (req, res) => {
  const folder = await folders.createFolder(req.auth!.userId, createFolderSchema.parse(req.body));
  res.status(201).json(folder);
});

router.patch('/:id', async (req, res) => {
  const folder = await folders.updateFolder(req.auth!.userId, objectId.parse(req.params.id), updateFolderSchema.parse(req.body));
  res.json(folder);
});

router.delete('/:id', async (req, res) => {
  await folders.deleteFolder(req.auth!.userId, objectId.parse(req.params.id));
  res.status(204).end();
});

export default router;
