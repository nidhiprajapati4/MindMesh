import { Router } from 'express';
import { z } from 'zod';
import { HttpError } from '../../middleware/errors';
import { Conversation } from '../../models/Conversation';
import { MAX_SAVED_ANSWERS, SavedAnswer } from '../../models/SavedAnswer';
import { objectId } from '../notes/notes.schema';

const router = Router();

const saveSchema = z.object({ conversationId: objectId, turnIndex: z.number().int().min(0) }).strict();

// Newest first. Only what the list needs; the full answer comes from GET /:id.
router.get('/', async (req, res) => {
  res.json(
    await SavedAnswer.find({ userId: req.auth!.userId }, { question: 1, conversationId: 1, turnIndex: 1, createdAt: 1 })
      .sort({ createdAt: -1 })
      .limit(MAX_SAVED_ANSWERS)
      .lean()
  );
});

router.get('/:id', async (req, res) => {
  const saved = await SavedAnswer.findOne({ _id: objectId.parse(req.params.id), userId: req.auth!.userId }).lean();
  if (!saved) throw new HttpError(404, 'Saved answer not found');
  res.json(saved);
});

// Saves a copy of one answer from a conversation. Saving it again returns the existing bookmark.
router.post('/', async (req, res) => {
  const userId = req.auth!.userId;
  const { conversationId, turnIndex } = saveSchema.parse(req.body);
  const existing = await SavedAnswer.findOne({ userId, conversationId, turnIndex }, { _id: 1 }).lean();
  if (existing) return res.json({ _id: String(existing._id) });

  if ((await SavedAnswer.countDocuments({ userId })) >= MAX_SAVED_ANSWERS) {
    throw new HttpError(400, `You can save up to ${MAX_SAVED_ANSWERS} answers. Remove some to save more.`);
  }
  const conv = await Conversation.findOne({ _id: conversationId, userId }, { turns: { $slice: [turnIndex, 1] } }).lean();
  const turn = conv?.turns[0];
  if (!turn) throw new HttpError(404, 'Answer not found');
  const saved = await SavedAnswer.create({
    userId,
    conversationId,
    turnIndex,
    question: turn.question,
    segments: turn.segments,
    sources: turn.sources,
  });
  res.status(201).json({ _id: String(saved._id) });
});

router.delete('/:id', async (req, res) => {
  const r = await SavedAnswer.deleteOne({ _id: objectId.parse(req.params.id), userId: req.auth!.userId });
  if (!r.deletedCount) throw new HttpError(404, 'Saved answer not found');
  res.status(204).end();
});

export default router;
