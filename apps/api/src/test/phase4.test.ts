import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { client, emulatorToken, startTestApi } from './helpers';
import type { AnswerProvider } from '../platform/generation/types';

let api: Awaited<ReturnType<typeof startTestApi>>;
let A: ReturnType<typeof client>;
let B: ReturnType<typeof client>;
const tokenA = emulatorToken('p4-user-a');
const tokenB = emulatorToken('p4-user-b');

let pipeline: typeof import('../modules/ai-processing/pipeline');
let ai: typeof import('../platform/ai-client');
let fakeAnswerProvider: AnswerProvider;
let resetAskRateLimit: () => void;
let Usage: typeof import('../models/Usage').Usage;
let Conversation: typeof import('../models/Conversation').Conversation;

type SseEvent = { event: string; data: any };

/** POSTs a question and collects the server-sent events (optionally aborting after `stopAfter` text events). */
async function ask(token: string, body: Record<string, unknown>, opts: { stopAfter?: number } = {}) {
  const controller = new AbortController();
  const res = await fetch(`${api.base}/api/ask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: controller.signal,
  });
  if (!res.headers.get('content-type')?.startsWith('text/event-stream')) return { status: res.status, json: await res.json(), events: [] as SseEvent[] };

  const events: SseEvent[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let texts = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
        const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? 'null');
        events.push({ event, data });
        if (event === 'text' && opts.stopAfter && ++texts >= opts.stopAfter) controller.abort();
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
  return { status: res.status, json: null, events };
}

const textOf = (events: SseEvent[]) => events.filter((e) => e.event === 'text').map((e) => e.data.text).join('');
const ev = (events: SseEvent[], name: string) => events.find((e) => e.event === name)?.data;

/** Wraps the fake answerer to count calls and capture requests. */
function spy(base: AnswerProvider = fakeAnswerProvider) {
  const requests: Parameters<AnswerProvider['answer']>[0][] = [];
  const p: AnswerProvider = { ...base, answer: (req, o) => (requests.push(req), base.answer(req, o)) };
  ai.setAnswerProvider(p);
  return requests;
}

let retry: { _id: string };
let carbon: { _id: string };

before(async () => {
  api = await startTestApi();
  A = client(api.base, tokenA);
  B = client(api.base, tokenB);
  pipeline = await import('../modules/ai-processing/pipeline.js');
  ai = await import('../platform/ai-client.js');
  ({ fakeAnswerProvider } = await import('../platform/generation/fake.js'));
  ({ resetAskRateLimit } = await import('../modules/ask/ask.routes.js'));
  ({ Usage } = await import('../models/Usage.js'));
  ({ Conversation } = await import('../models/Conversation.js'));

  retry = (await A.post('/api/notes', { title: 'Retry helper', content: 'Use exponential backoff with jitter for network retries. Cap at five attempts.' })).body;
  carbon = (await A.post('/api/notes', { title: 'Carbon capture', content: 'Direct air capture pulls carbon dioxide from the air. It costs over 400 dollars per tonne.' })).body;
  await A.post('/api/notes', { title: 'Sourdough starter', content: 'Feed the starter flour and water daily.' });
  await B.post('/api/notes', { title: 'B private retry notes', content: 'User B network retries with jitter secret.' });
  await pipeline.drain();
});

after(async () => {
  await api?.stop();
});

beforeEach(() => {
  resetAskRateLimit();
  ai.setAnswerProvider(null);
});

describe('Asking questions', () => {
  it('ASK-01 streams sources, answer text and citations, then saves the turn', async () => {
    const r = await ask(tokenA, { question: 'How should network retries use backoff and jitter?' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.events.map((e) => e.event).filter((e, i, a) => a.indexOf(e) === i), ['start', 'text', 'citation', 'done']);

    const start = ev(r.events, 'start');
    assert.equal(start.sources[0].noteId, retry._id, 'most relevant note first');
    const cite = ev(r.events, 'citation');
    assert.equal(start.sources[cite.source].noteId, retry._id, 'citation points at the retry note');
    assert.match(cite.quote, /exponential backoff/);
    assert.match(textOf(r.events), /exponential backoff/);

    const done = ev(r.events, 'done');
    assert.equal(done.turnIndex, 0);
    assert.equal(done.turn.status, 'complete');
    const conv = (await A.get(`/api/conversations/${start.conversationId}`)).body;
    assert.equal(conv.title, 'How should network retries use backoff and jitter?');
    assert.equal(conv.turns[0].segments.map((s: { text: string }) => s.text).join(''), textOf(r.events));
    assert.equal(String(conv.turns[0].sources[conv.turns[0].segments.find((s: any) => s.citations.length).citations[0].source].noteId), retry._id);
  });

  it('ASK-02 nothing relevant: says so without calling the model', async () => {
    const calls = spy();
    const r = await ask(tokenA, { question: 'volcanic eruptions in Iceland' });
    assert.equal(calls.length, 0, 'the model was called');
    assert.deepEqual(ev(r.events, 'start').sources, []);
    assert.match(textOf(r.events), /couldn't find anything/);
    assert.equal(ev(r.events, 'done').turn.status, 'not_found');
  });

  it('ASK-03 follow-ups continue the conversation and send earlier turns as history', async () => {
    const first = await ask(tokenA, { question: 'What does direct air capture do?' });
    const conversationId = ev(first.events, 'start').conversationId;
    const calls = spy();
    const second = await ask(tokenA, { question: 'And how much does it cost?', conversationId });
    assert.equal(ev(second.events, 'start').conversationId, conversationId);
    assert.equal(ev(second.events, 'done').turnIndex, 1);
    assert.deepEqual(calls[0].history.map((h) => h.question), ['What does direct air capture do?']);
    assert.ok(ev(second.events, 'start').sources.some((s: { noteId: string }) => s.noteId === carbon._id));
  });

  it('ASK-03b changing topic mid-conversation does not drag in notes about the old topic', async () => {
    const first = await ask(tokenA, { question: 'How should network retries use backoff and jitter?' });
    const conversationId = ev(first.events, 'start').conversationId;
    assert.ok(ev(first.events, 'start').sources.some((s: { noteId: string }) => s.noteId === retry._id));
    const calls = spy();
    const second = await ask(tokenA, { question: 'volcanic eruptions in Iceland', conversationId });
    assert.deepEqual(ev(second.events, 'start').sources, [], 'the retry note was carried over');
    assert.equal(calls.length, 0);
    assert.equal(ev(second.events, 'done').turn.status, 'not_found');
  });

  it('ASK-04 user B never gets user A’s notes or conversations', async () => {
    const a = await ask(tokenA, { question: 'network retries jitter' });
    const conversationId = ev(a.events, 'start').conversationId;

    const b = await ask(tokenB, { question: 'network retries jitter' });
    for (const s of ev(b.events, 'start').sources) assert.notEqual(s.noteId, retry._id);
    assert.ok(ev(b.events, 'start').sources.every((s: { title: string }) => s.title === 'B private retry notes'));

    assert.equal((await ask(tokenB, { question: 'hi', conversationId })).status, 404);
    assert.equal((await B.get(`/api/conversations/${conversationId}`)).status, 404);
    assert.equal((await B.patch(`/api/conversations/${conversationId}`, { title: 'mine' })).status, 404);
    assert.equal((await B.post(`/api/conversations/${conversationId}/turns/0/feedback`, { rating: 'down' })).status, 404);
    assert.equal((await B.del(`/api/conversations/${conversationId}`)).status, 404);
    assert.ok(!(await B.get('/api/conversations')).body.some((c: { _id: string }) => c._id === conversationId));
  });

  it('ASK-05 trashed notes are never used as sources', async () => {
    const n = (await A.post('/api/notes', { title: 'Kubernetes probes', content: 'Readiness probes gate traffic to pods.' })).body;
    await pipeline.drain();
    assert.ok(ev((await ask(tokenA, { question: 'readiness probes pods' })).events, 'start').sources.some((s: any) => s.noteId === n._id));
    await A.del(`/api/notes/${n._id}`);
    assert.ok(!ev((await ask(tokenA, { question: 'readiness probes pods' })).events, 'start').sources.some((s: any) => s.noteId === n._id));
  });
});

describe('Failures and limits', () => {
  it('ASK-10 validates input and requires sign-in', async () => {
    assert.equal((await ask(tokenA, { question: '   ' })).status, 400);
    assert.equal((await ask(tokenA, { question: 'x'.repeat(1001) })).status, 400);
    assert.equal((await ask(tokenA, { question: 'hi', conversationId: 'nope' })).status, 400);
    assert.equal((await ask(tokenA, { question: 'hi', conversationId: '000000000000000000000000' })).status, 404);
    assert.equal((await ask(tokenA, { question: 'hi', extra: 1 })).status, 400);
    const anon = await fetch(`${api.base}/api/ask`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"question":"hi"}' });
    assert.equal(anon.status, 401);
  });

  it('ASK-11 over the daily budget: 429 before anything streams', async () => {
    const C = client(api.base, emulatorToken('p4-user-c'));
    const userC = (await C.get('/api/me')).body.userId;
    await Usage.updateOne({ userId: userC, day: new Date().toISOString().slice(0, 10) }, { $set: { genTokens: 200_000 } }, { upsert: true });
    const r = await ask(emulatorToken('p4-user-c'), { question: 'anything at all' });
    assert.equal(r.status, 429);
    assert.equal(r.json.code, 'QUOTA_EXCEEDED');
  });

  it('ASK-12 a model failure streams a friendly error and saves the turn as failed', async () => {
    ai.setAnswerProvider({ ...fakeAnswerProvider, answer: async () => { throw new Error('upstream exploded'); } });
    const r = await ask(tokenA, { question: 'network retries' });
    assert.deepEqual(ev(r.events, 'error'), { code: 'ANSWER_FAILED', message: "Couldn't write an answer right now. Please try again." });
    const done = ev(r.events, 'done');
    assert.equal(done.turn.status, 'error');
    assert.ok(!JSON.stringify(r.events).includes('exploded'), 'internal error text leaked to the client');
  });

  it('ASK-13 a refusal is reported plainly', async () => {
    const { AnswerRefusedError } = await import('../platform/generation/types.js');
    ai.setAnswerProvider({ ...fakeAnswerProvider, answer: async () => { throw new AnswerRefusedError('cyber'); } });
    const r = await ask(tokenA, { question: 'network retries' });
    assert.equal(ev(r.events, 'error').code, 'REFUSED');
  });

  it('ASK-14 Stop: the model is cancelled and the partial answer is saved as stopped', async () => {
    let cancelled = false;
    ai.setAnswerProvider({
      ...fakeAnswerProvider,
      answer: (_req, { signal, onEvent }) =>
        new Promise((_, reject) => {
          signal.addEventListener('abort', () => {
            cancelled = true;
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          });
          onEvent({ type: 'text', text: 'Partial answer' });
          onEvent({ type: 'citation', docIndex: 0, quote: 'Use exponential backoff' });
        }),
    });
    const r = await ask(tokenA, { question: 'network retries stop test' }, { stopAfter: 1 });
    const conversationId = ev(r.events, 'start').conversationId;

    let turn;
    for (let i = 0; i < 50 && !turn; i++) {
      turn = (await Conversation.findById(conversationId).lean())?.turns[0];
      if (!turn) await new Promise((res) => setTimeout(res, 50));
    }
    assert.ok(cancelled, 'the model call kept running after the client left');
    assert.equal(turn!.status, 'stopped');
    assert.equal(turn!.segments[0].text, 'Partial answer');
    assert.equal(turn!.segments[0].citations[0].source, 0);
  });

  it('ASK-15 at most 10 questions a minute per user', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await ask(tokenA, { question: `volcano ${i}` })).status, 200);
    const r = await ask(tokenA, { question: 'one too many' });
    assert.equal(r.status, 429);
    assert.equal(r.json.code, 'RATE_LIMITED');
    assert.equal((await ask(tokenB, { question: 'volcano' })).status, 200, 'other users are unaffected');
  });
});

describe('Conversation history', () => {
  it('CONV-01 list, rename, feedback and delete', async () => {
    const r = await ask(tokenA, { question: 'Tell me about sourdough' });
    const id = ev(r.events, 'start').conversationId;

    const list = (await A.get('/api/conversations')).body;
    assert.equal(list[0]._id, id, 'newest first');
    assert.equal(list[0].turnCount, 1);
    assert.equal(list[0].turns, undefined, 'the list does not carry full answers');

    assert.equal((await A.patch(`/api/conversations/${id}`, { title: 'Bread' })).body.title, 'Bread');
    assert.equal((await A.patch(`/api/conversations/${id}`, { title: '' })).status, 400);

    assert.equal((await A.post(`/api/conversations/${id}/turns/0/feedback`, { rating: 'up', comment: 'helpful' })).status, 204);
    assert.deepEqual((await A.get(`/api/conversations/${id}`)).body.turns[0].feedback, { rating: 'up', comment: 'helpful' });
    assert.equal((await A.post(`/api/conversations/${id}/turns/5/feedback`, { rating: 'up' })).status, 404);
    assert.equal((await A.post(`/api/conversations/${id}/turns/-1/feedback`, { rating: 'up' })).status, 400);
    assert.equal((await A.post(`/api/conversations/${id}/turns/0/feedback`, { rating: 'meh' })).status, 400);

    assert.equal((await A.del(`/api/conversations/${id}`)).status, 204);
    assert.equal((await A.get(`/api/conversations/${id}`)).status, 404);
  });
});
