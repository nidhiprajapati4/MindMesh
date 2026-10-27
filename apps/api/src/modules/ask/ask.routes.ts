import { Router } from 'express';
import { HttpError } from '../../middleware/errors';
import { answerSetup } from '../../platform/ai-client';
import { objectId } from '../notes/notes.schema';
import { askSchema, feedbackSchema, renameConversationSchema } from './ask.schema';
import * as ask from './ask.service';

/** Per-user sliding window: each question can cost real money, so bursts are capped. */
export const ASK_RATE_LIMIT = { max: 10, windowMs: 60_000 };
const recent = new Map<string, number[]>();

let lastSweep = Date.now();

function takeRateLimitSlot(userId: string) {
  const now = Date.now();
  // Forget users who haven't asked within the window, so the map doesn't grow forever.
  if (now - lastSweep > ASK_RATE_LIMIT.windowMs) {
    for (const [id, times] of recent) if (now - (times.at(-1) ?? 0) >= ASK_RATE_LIMIT.windowMs) recent.delete(id);
    lastSweep = now;
  }
  const times = (recent.get(userId) ?? []).filter((t) => now - t < ASK_RATE_LIMIT.windowMs);
  if (times.length >= ASK_RATE_LIMIT.max) throw new HttpError(429, 'Too many questions in a short time. Wait a minute and try again.', 'RATE_LIMITED');
  times.push(now);
  recent.set(userId, times);
}

/** Tests only. */
export const resetAskRateLimit = () => recent.clear();
export const rateLimitedUsers = () => recent.size;

export const askRouter = Router();

// Which answer mode the server uses (Claude, free smart quotes, or the test answerer), for the Ask page.
askRouter.get('/status', (_req, res) => {
  res.json(answerSetup());
});

// POST /api/ask → text/event-stream: start, text*, citation*, (error), done
askRouter.post('/', async (req, res) => {
  const userId = req.auth!.userId;
  const input = askSchema.parse(req.body);
  takeRateLimitSlot(userId);
  // Plain HTTP errors (404, 429 budget…) can still be returned up to this point.
  const prepared = await ask.prepareAsk(userId, input);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let a proxy hold the stream back
  });
  // The client pressing Stop (or leaving) closes the connection; stop generating and paying.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const send = (event: string, data: unknown) => {
    if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    await ask.runAsk(userId, input, prepared, send, controller.signal);
  } catch (e) {
    console.error('Ask failed after streaming started', e);
    send('error', { code: 'ANSWER_FAILED', message: "Couldn't write an answer right now. Please try again." });
  } finally {
    res.end();
  }
});

export const conversationsRouter = Router();
const convId = (id: string) => objectId.parse(id);

conversationsRouter.get('/', async (req, res) => {
  res.json(await ask.listConversations(req.auth!.userId));
});

conversationsRouter.get('/:id', async (req, res) => {
  res.json(await ask.getConversation(req.auth!.userId, convId(req.params.id)));
});

conversationsRouter.patch('/:id', async (req, res) => {
  res.json(await ask.renameConversation(req.auth!.userId, convId(req.params.id), renameConversationSchema.parse(req.body).title));
});

conversationsRouter.delete('/:id', async (req, res) => {
  await ask.deleteConversation(req.auth!.userId, convId(req.params.id));
  res.status(204).end();
});

conversationsRouter.post('/:id/turns/:turn/feedback', async (req, res) => {
  const turn = Number(req.params.turn);
  if (!Number.isInteger(turn) || turn < 0) throw new HttpError(400, 'Invalid answer index');
  await ask.setFeedback(req.auth!.userId, convId(req.params.id), turn, feedbackSchema.parse(req.body));
  res.status(204).end();
});
