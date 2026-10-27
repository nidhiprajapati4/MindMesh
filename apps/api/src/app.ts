import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { requireAuth } from './middleware/auth';
import { errorHandler } from './middleware/errors';
import { askRouter, conversationsRouter } from './modules/ask/ask.routes';
import foldersRouter from './modules/folders/folders.routes';
import notesRouter from './modules/notes/notes.routes';
import organizeRouter from './modules/organize/organize.routes';
import searchRouter from './modules/search/search.routes';

export const app = express();

app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN.split(',').map((o) => o.trim()) }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  res.json({ userId: req.auth!.userId, uid: req.auth!.uid });
});
app.use('/api/notes', requireAuth, notesRouter);
app.use('/api/folders', requireAuth, foldersRouter);
app.use('/api/search', requireAuth, searchRouter);
app.use('/api/ask', requireAuth, askRouter);
app.use('/api/conversations', requireAuth, conversationsRouter);
app.use('/api/organize', requireAuth, organizeRouter);

app.use(errorHandler);
