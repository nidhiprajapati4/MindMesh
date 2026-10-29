import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import { env } from './config/env';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/errors';
import { apiLimits } from './middleware/rate-limit';
import { requestContextMiddleware } from './middleware/request-context';
import { askRouter, conversationsRouter } from './modules/ask/ask.routes';
import connectionsRouter from './modules/connections/connections.routes';
import foldersRouter from './modules/folders/folders.routes';
import notesRouter from './modules/notes/notes.routes';
import organizeRouter from './modules/organize/organize.routes';
import searchRouter from './modules/search/search.routes';
import { embeddingProvider } from './platform/ai-client';
import { localModelState } from './platform/embeddings/local';
import { workerRunning } from './worker/loop';

export const app = express();
/** Set while the server shuts down, so health checks stop sending it traffic. */
export const lifecycle = { shuttingDown: false };

// Behind a proxy (Render), read the client's IP from X-Forwarded-For, for per-IP limits.
app.set('trust proxy', env.TRUST_PROXY);
app.use(requestContextMiddleware);
app.use(helmet());
app.use(cors({ origin: env.CLIENT_ORIGIN.split(',').map((o) => o.trim()), exposedHeaders: ['X-Request-Id', 'Retry-After'] }));
app.use(express.json({ limit: '1mb' }));

// Liveness: the process is up.
app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

// Readiness: the database answers. Also reports the worker and embedding model, for operators.
app.get('/ready', async (_req, res) => {
  const db = mongoose.connection.readyState === 1 && (await mongoose.connection.db?.admin().ping().then(() => true, () => false));
  const ok = !!db && !lifecycle.shuttingDown;
  res.status(ok ? 200 : 503).json({
    ok,
    db: db ? 'up' : 'down',
    ...(lifecycle.shuttingDown ? { shuttingDown: true } : {}),
    worker: env.RUN_WORKER === 'inline' ? (workerRunning() ? 'running' : 'stopped') : 'separate process',
    embeddingModel: embeddingProvider().name === 'local' ? localModelState() : embeddingProvider().name,
    // The commit this server runs (set by Render), so a deploy can confirm its code is live.
    ...(process.env.RENDER_GIT_COMMIT ? { commit: process.env.RENDER_GIT_COMMIT } : {}),
  });
});

app.use('/api', apiLimits.ip);
const signedIn = [requireAuth, apiLimits.user];

app.get('/api/me', ...signedIn, async (req, res) => {
  res.json({ userId: req.auth!.userId, uid: req.auth!.uid });
});
app.use('/api/notes', ...signedIn, notesRouter);
app.use('/api/folders', ...signedIn, foldersRouter);
app.use('/api/search', ...signedIn, searchRouter);
app.use('/api/ask', ...signedIn, askRouter);
app.use('/api/conversations', ...signedIn, conversationsRouter);
app.use('/api/organize', ...signedIn, organizeRouter);
app.use('/api/connections', ...signedIn, connectionsRouter);

app.use(notFoundHandler);
app.use(errorHandler);
