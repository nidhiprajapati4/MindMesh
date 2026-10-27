import { Router } from 'express';
import { HttpError } from '../../middleware/errors';
import { createLimiter } from '../../middleware/rate-limit';
import { requestContext } from '../../middleware/request-context';
import { answerSetup } from '../../platform/ai-client';
import { log } from '../../platform/logger';
import { objectId } from '../notes/notes.schema';
import { askSchema, feedbackSchema, renameConversationSchema } from './ask.schema';
import * as ask from './ask.service';

/** Per-user sliding window: each question can cost real money, so bursts are capped. */
const askLimiter = createLimiter('ask', { max: 10, windowMs: 60_000, message: 'Too many questions in a short time. Wait a minute and try again.' });

/** Tests only. */
export const resetAskRateLimit = () => askLimiter.reset();

export const askRouter = Router();

// Which answer mode the server uses (Claude, free smart quotes, or the test answerer), for the Ask page.
askRouter.get('/status', (_req, res) => {
  res.json(answerSetup());
});

// POST /api/ask → text/event-stream: start, text*, citation*, (error), done
askRouter.post('/', async (req, res) => {
  const userId = req.auth!.userId;
  const input = askSchema.parse(req.body);
  askLimiter.take(`user:${userId}`); // after validation, so a rejected question doesn't use up a slot
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
    log.error('ask_failed_mid_stream', { err: e });
    send('error', { code: 'ANSWER_FAILED', message: "Couldn't write an answer right now. Please try again.", requestId: requestContext()?.requestId });
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
