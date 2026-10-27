import { Types } from 'mongoose';
import { HttpError } from '../../middleware/errors';
import { Conversation, MAX_TURNS, TURN_STATUSES } from '../../models/Conversation';
import { generateAnswer } from '../../platform/ai-client';
import { AnswerRefusedError, type AnswerSegment } from '../../platform/generation/types';
import { QUOTA_EXCEEDED } from '../../platform/quota';
import type { AskInput } from './ask.schema';
import { retrieveForQuestion, type RetrievedNote } from './retrieve';

export const NOT_FOUND_ANSWER = "I couldn't find anything about that in your notes.";
/** Earlier turns sent to the model so follow-up questions make sense. */
const HISTORY_TURNS = 3;

type SendEvent = (event: string, data: unknown) => void;
/** A turn as plain data (what gets pushed into `conversations.turns`). */
type TurnData = {
  question: string;
  segments: { text: string; citations: { source: number; quote: string }[] }[];
  sources: { noteId: Types.ObjectId; title: string }[];
  status: (typeof TURN_STATUSES)[number];
  error: string | null;
  feedback: { rating: null; comment: string };
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  createdAt: Date;
};
type Prepared = { conversationId: Types.ObjectId | null; history: { question: string; answer: string }[]; sources: RetrievedNote[] };

const turnText = (t: { segments?: { text?: string | null }[] | null }) => (t.segments ?? []).map((s) => s.text ?? '').join('');

/**
 * Everything that can fail with a plain HTTP error (unknown conversation, full conversation,
 * budget reached while embedding the question) happens here, before the response starts streaming.
 */
export async function prepareAsk(userId: string, input: AskInput): Promise<Prepared> {
  let conversationId: Types.ObjectId | null = null;
  let history: Prepared['history'] = [];
  let previousQuestion: string | undefined;

  if (input.conversationId) {
    const conv = await Conversation.findOne({ _id: input.conversationId, userId }, { turns: 1 }).lean();
    if (!conv) throw new HttpError(404, 'Conversation not found');
    if (conv.turns.length >= MAX_TURNS) throw new HttpError(400, 'This conversation is full. Start a new one.');
    conversationId = conv._id;
    const answered = conv.turns.filter((t) => t.status === 'complete');
    history = answered.slice(-HISTORY_TURNS).map((t) => ({ question: t.question, answer: turnText(t) }));
    previousQuestion = conv.turns.at(-1)?.question;
  }

  const sources = await retrieveForQuestion(userId, input.question, previousQuestion);
  return { conversationId, history, sources };
}

function friendlyError(e: unknown): { code: string; message: string } {
  if ((e as { code?: string })?.code === QUOTA_EXCEEDED) return { code: QUOTA_EXCEEDED, message: (e as Error).message };
  if (e instanceof AnswerRefusedError) return { code: 'REFUSED', message: 'The assistant declined to answer this question.' };
  if ((e as Error)?.name === 'TimeoutError') return { code: 'TIMEOUT', message: 'The answer took too long. Please try again.' };
  return { code: 'ANSWER_FAILED', message: "Couldn't write an answer right now. Please try again." };
}

/**
 * Streams an answer as events — `start`, then `text` / `citation` pieces, then `done` (or `error`) —
 * and saves the turn. If `signal` aborts (the user pressed Stop or left), the partial answer is
 * saved as `stopped`.
 */
export async function runAsk(userId: string, input: AskInput, prepared: Prepared, send: SendEvent, signal: AbortSignal) {
  const { sources, history } = prepared;
  const conversationId =
    prepared.conversationId ?? (await Conversation.create({ userId, title: input.question.slice(0, 80) }))._id;
  const sourceList = sources.map((s, i) => ({ index: i, noteId: s.noteId, title: s.title, type: s.type }));
  send('start', { conversationId: String(conversationId), sources: sourceList });

  const turn: TurnData = {
    question: input.question,
    segments: [],
    sources: sources.map((s) => ({ noteId: new Types.ObjectId(s.noteId), title: s.title })),
    status: 'complete',
    error: null,
    feedback: { rating: null, comment: '' },
    model: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    createdAt: new Date(),
  };
  const inRange = (i: number) => Number.isInteger(i) && i >= 0 && i < sources.length;

  if (!sources.length) {
    // Nothing relevant: say so without calling (or paying for) the model.
    turn.status = 'not_found';
    turn.segments = [{ text: NOT_FOUND_ANSWER, citations: [] }];
    send('text', { text: NOT_FOUND_ANSWER });
  } else {
    // Mirrors what has streamed, so a stopped answer can be saved as far as it got.
    const partial: AnswerSegment = { text: '', citations: [] };
    try {
      const result = await generateAnswer(
        { history, question: input.question, docs: sources.map((s) => ({ title: s.title, text: s.text })) },
        {
          userId,
          signal,
          onEvent: (e) => {
            if (e.type === 'text') {
              partial.text += e.text;
              send('text', { text: e.text });
            } else if (inRange(e.docIndex)) {
              partial.citations.push(e);
              send('citation', { source: e.docIndex, quote: e.quote });
            }
          },
        }
      );
      turn.segments = result.segments.map((s) => ({
        text: s.text,
        citations: s.citations.filter((c) => inRange(c.docIndex)).map((c) => ({ source: c.docIndex, quote: c.quote })),
      }));
      Object.assign(turn, { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd });
    } catch (e) {
      turn.segments = partial.text ? [{ text: partial.text, citations: partial.citations.map((c) => ({ source: c.docIndex, quote: c.quote })) }] : [];
      if (signal.aborted) turn.status = 'stopped';
      else {
        const err = friendlyError(e);
        if (err.code === 'ANSWER_FAILED') console.error('Answer failed', e);
        turn.status = 'error';
        turn.error = err.message;
        send('error', err);
      }
    }
  }

  // Only the status of each turn is read back, to learn this turn's index (used for feedback).
  const saved = await Conversation.findOneAndUpdate({ _id: conversationId, userId }, { $push: { turns: turn } }, { new: true, projection: { 'turns.status': 1 } }).lean();
  send('done', { conversationId: String(conversationId), turnIndex: saved ? saved.turns.length - 1 : -1, turn });
}

// --- Conversation history -------------------------------------------------------------------

export async function listConversations(userId: string) {
  return Conversation.aggregate([
    { $match: { userId: new Types.ObjectId(userId) } },
    { $sort: { updatedAt: -1 } },
    { $limit: 100 },
    { $project: { title: 1, updatedAt: 1, createdAt: 1, turnCount: { $size: '$turns' } } },
  ]);
}

export async function getConversation(userId: string, id: string) {
  const conv = await Conversation.findOne({ _id: id, userId }).lean();
  if (!conv) throw new HttpError(404, 'Conversation not found');
  return conv;
}

export async function renameConversation(userId: string, id: string, title: string) {
  const conv = await Conversation.findOneAndUpdate({ _id: id, userId }, { $set: { title } }, { new: true, projection: { title: 1, updatedAt: 1 } }).lean();
  if (!conv) throw new HttpError(404, 'Conversation not found');
  return conv;
}

export async function deleteConversation(userId: string, id: string) {
  const r = await Conversation.deleteOne({ _id: id, userId });
  if (!r.deletedCount) throw new HttpError(404, 'Conversation not found');
}

export async function setFeedback(userId: string, id: string, turnIndex: number, feedback: { rating: 'up' | 'down' | null; comment: string }) {
  const r = await Conversation.updateOne(
    { _id: id, userId, [`turns.${turnIndex}`]: { $exists: true } },
    { $set: { [`turns.${turnIndex}.feedback`]: feedback } }
  );
  if (!r.matchedCount) throw new HttpError(404, 'Answer not found');
}
