import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import { startTestApi } from '../../test/helpers';
import type { AnswerEvent, AnswerProvider, AnswerRequest } from './types';

let api: Awaited<ReturnType<typeof startTestApi>>;
let ai: typeof import('../ai-client');
let quota: typeof import('../quota');
let Usage: typeof import('../../models/Usage').Usage;
let fakeAnswerProvider: typeof import('./fake').fakeAnswerProvider;
let FAKE_NOT_FOUND: string;
let anthropicAnswerProvider: typeof import('./anthropic').anthropicAnswerProvider;
let ANSWER_SYSTEM_PROMPT: string;
let RetryableError: typeof import('../embeddings/types').RetryableError;
let AnswerRefusedError: typeof import('./types').AnswerRefusedError;
let userId: string;

before(async () => {
  api = await startTestApi(); // in-memory MongoDB for the usage counters
  ai = await import('../ai-client.js');
  quota = await import('../quota.js');
  ({ Usage } = await import('../../models/Usage.js'));
  ({ fakeAnswerProvider, FAKE_NOT_FOUND } = await import('./fake.js'));
  ({ anthropicAnswerProvider, ANSWER_SYSTEM_PROMPT } = await import('./anthropic.js'));
  ({ RetryableError } = await import('../embeddings/types.js'));
  ({ AnswerRefusedError } = await import('./types.js'));
  userId = new (await import('mongoose')).Types.ObjectId().toString();
});

after(async () => {
  await api?.stop();
});

afterEach(() => {
  ai.setAnswerProvider(null);
  ai.answerTimeouts.firstTokenMs = 20_000;
});

const req: AnswerRequest = {
  history: [],
  question: 'How should I retry failed network requests?',
  docs: [
    { title: 'Retry helper', text: 'Use exponential backoff with jitter for network retries. Cap at five attempts.' },
    { title: 'Sourdough', text: 'Feed the starter daily.' },
  ],
};

const collect = () => {
  const events: AnswerEvent[] = [];
  return { events, onEvent: (e: AnswerEvent) => events.push(e) };
};

/** A provider scripted per call: each step emits some text and/or throws. */
function scripted(steps: ((emit: (t: string) => void, signal: AbortSignal) => Promise<void>)[]) {
  let calls = 0;
  const p: AnswerProvider = {
    name: 'scripted',
    model: 'scripted-1',
    costPerMillion: { input: 1, output: 2 },
    async answer(_r, { signal, onEvent }) {
      const step = steps[Math.min(calls++, steps.length - 1)];
      await step((text) => onEvent({ type: 'text', text }), signal);
      return { segments: [{ text: 'ok', citations: [] }], model: 'scripted-1', inputTokens: 100, outputTokens: 10 };
    },
  };
  return { p, calls: () => calls };
}

describe('Answer generation (ai-client)', () => {
  it('GEN-01 the fake answerer streams text and citations, and usage is charged', async () => {
    const before = (await quota.getUsage(userId)).genTokens;
    const { events, onEvent } = collect();
    const r = await ai.generateAnswer(req, { userId, onEvent });

    const streamed = events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('');
    assert.equal(streamed, r.segments.map((s) => s.text).join(''));
    assert.match(streamed, /exponential backoff/);
    assert.deepEqual(events.filter((e) => e.type === 'citation').map((e) => (e as { docIndex: number }).docIndex), [0]);
    assert.equal(r.segments.find((s) => s.citations.length)!.citations[0].docIndex, 0);
    assert.ok((await quota.getUsage(userId)).genTokens > before);
  });

  it('GEN-02 with no relevant notes the fake answerer says so and cites nothing', async () => {
    const { events, onEvent } = collect();
    const r = await ai.generateAnswer({ ...req, question: 'volcanoes in iceland' }, { userId, onEvent });
    assert.equal(r.segments.map((s) => s.text).join(''), FAKE_NOT_FOUND);
    assert.equal(events.filter((e) => e.type === 'citation').length, 0);
  });

  it('GEN-03 over budget: refused before the model is called', async () => {
    const { p, calls } = scripted([async () => undefined]);
    ai.setAnswerProvider(p);
    const broke = new (await import('mongoose')).Types.ObjectId().toString();
    await Usage.updateOne({ userId: broke, day: quota.utcDay() }, { $set: { genTokens: 200_000 } }, { upsert: true });
    await assert.rejects(ai.generateAnswer(req, { userId: broke, onEvent: () => undefined }), { code: 'QUOTA_EXCEEDED' });
    assert.equal(calls(), 0);
  });

  it('GEN-04 a transient error before any text is retried', async () => {
    const { p, calls } = scripted([
      async () => { throw new RetryableError('503'); },
      async (emit) => emit('hello'),
    ]);
    ai.setAnswerProvider(p);
    const { events, onEvent } = collect();
    await ai.generateAnswer(req, { userId, onEvent });
    assert.equal(calls(), 2);
    assert.deepEqual(events, [{ type: 'text', text: 'hello' }], 'text from the failed attempt would be duplicated');
  });

  it('GEN-05 an error after text has streamed is not retried', async () => {
    const { p, calls } = scripted([
      async (emit) => { emit('partial'); throw new RetryableError('connection reset'); },
    ]);
    ai.setAnswerProvider(p);
    await assert.rejects(ai.generateAnswer(req, { userId, onEvent: () => undefined }), /connection reset/);
    assert.equal(calls(), 1);
  });

  it('GEN-06 no first token in time: times out (and is retried, as a transient failure)', async () => {
    ai.answerTimeouts.firstTokenMs = 30;
    const hang = (_e: unknown, signal: AbortSignal) =>
      new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const { p, calls } = scripted([hang]);
    ai.setAnswerProvider(p);
    await assert.rejects(ai.generateAnswer(req, { userId, onEvent: () => undefined }), { name: 'TimeoutError' });
    assert.equal(calls(), ai.MAX_RETRIES + 1);
  });

  it('GEN-07 when the caller cancels (user pressed Stop), it stops without retrying', async () => {
    const { p, calls } = scripted([
      (emit, signal) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        emit('started');
      }),
    ]);
    ai.setAnswerProvider(p);
    const stop = new AbortController();
    const run = ai.generateAnswer(req, { userId, signal: stop.signal, onEvent: () => stop.abort() });
    await assert.rejects(run, { name: 'AbortError' });
    assert.equal(calls(), 1);
  });

  it('GEN-09 a stopped answer still counts against the daily budget', async () => {
    const { p } = scripted([
      (emit, signal) => new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        emit('x'.repeat(400)); // ~100 tokens of answer before Stop
      }),
    ]);
    ai.setAnswerProvider(p);
    const user = new (await import('mongoose')).Types.ObjectId().toString();
    const stop = new AbortController();
    await assert.rejects(ai.generateAnswer(req, { userId: user, signal: stop.signal, onEvent: () => stop.abort() }));
    const used = (await quota.getUsage(user)).genTokens;
    assert.ok(used >= 100, `only ${used} tokens charged for a stopped answer`);
  });

  it('GEN-10 without a key, production switches answers off instead of faking them', async () => {
    const { env } = await import('../../config/env.js');
    const saved = { NODE_ENV: env.NODE_ENV, ANSWER_PROVIDER: env.ANSWER_PROVIDER, ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY };
    try {
      Object.assign(env, { NODE_ENV: 'production', ANSWER_PROVIDER: undefined, ANTHROPIC_API_KEY: '' });
      assert.deepEqual(ai.answerSetup(), { available: false, provider: 'none', model: null });
      assert.throws(() => ai.answerProvider(), { code: 'ANSWERS_NOT_CONFIGURED' });
      Object.assign(env, { NODE_ENV: 'development' });
      assert.equal(ai.answerSetup().provider, 'fake', 'development keeps the demo answerer');
      Object.assign(env, { ANTHROPIC_API_KEY: 'sk-ant-test' });
      assert.equal(ai.answerSetup().provider, 'anthropic', 'a key selects Claude');
    } finally {
      Object.assign(env, saved);
    }
  });

  it('GEN-08 a provider that ignores cancellation still cannot hang the request', async () => {
    ai.answerTimeouts.firstTokenMs = 30;
    const { p } = scripted([() => new Promise<void>(() => undefined)]); // never settles, never listens
    ai.setAnswerProvider(p);
    const started = Date.now();
    await assert.rejects(ai.generateAnswer(req, { userId, onEvent: () => undefined }), { name: 'TimeoutError' });
    assert.ok(Date.now() - started < 10_000, 'gave up promptly');
  });
});

describe('Claude provider (recorded stream, no network)', () => {
  const sse = (events: object[]) =>
    events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join('');

  const recorded = (stopReason = 'end_turn') => [
    { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 300, cache_creation_input_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Retry with exponential backoff and jitter.' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'citations_delta', citation: { type: 'char_location', cited_text: 'Use exponential backoff with jitter for network retries.', document_index: 0, document_title: 'Retry helper', start_char_index: 0, end_char_index: 56, file_id: null } } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 42 } },
    { type: 'message_stop' },
  ];

  function fakeFetch(status: number, body: string) {
    const calls: { url: string; headers: Headers; body: any }[] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response(body, { status, headers: { 'content-type': status === 200 ? 'text/event-stream' : 'application/json', 'request-id': 'req_test' } });
    }) as typeof fetch;
    return { f, calls };
  }

  it('CLAUDE-01 sends citable documents, the cached system prompt, effort and fallbacks', async () => {
    const { f, calls } = fakeFetch(200, sse(recorded()));
    const p = anthropicAnswerProvider('sk-test', 'claude-opus-5-5', { fetch: f });
    await p.answer({ ...req, history: [{ question: 'earlier?', answer: 'earlier answer' }] }, { signal: new AbortController().signal, onEvent: () => undefined });

    const body = calls[0].body;
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.stream, true);
    assert.deepEqual(body.output_config, { effort: 'medium' });
    assert.equal(body.fallbacks, 'default');
    assert.match(calls[0].headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
    assert.equal(body.system[0].text, ANSWER_SYSTEM_PROMPT);
    assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
    assert.deepEqual(body.messages.slice(0, 2).map((m: { role: string }) => m.role), ['user', 'assistant'], 'history first');
    const last = body.messages.at(-1).content;
    assert.equal(last.length, 3);
    assert.deepEqual(last[0], { type: 'document', source: { type: 'text', media_type: 'text/plain', data: req.docs[0].text }, title: 'Retry helper', citations: { enabled: true } });
    assert.deepEqual(last[2], { type: 'text', text: req.question }, 'question after the documents');
  });

  it('CLAUDE-02 parses streamed text, citations and real token usage', async () => {
    const { f } = fakeFetch(200, sse(recorded()));
    const p = anthropicAnswerProvider('sk-test', 'claude-opus-5-5', { fetch: f });
    const { events, onEvent } = collect();
    const r = await p.answer(req, { signal: new AbortController().signal, onEvent });
    assert.deepEqual(events, [
      { type: 'text', text: 'Retry with exponential backoff and jitter.' },
      { type: 'citation', docIndex: 0, quote: 'Use exponential backoff with jitter for network retries.' },
    ]);
    assert.deepEqual(r.segments, [{ text: 'Retry with exponential backoff and jitter.', citations: [{ docIndex: 0, quote: 'Use exponential backoff with jitter for network retries.' }] }]);
    assert.equal(r.inputTokens, 1500, 'includes cached input');
    assert.equal(r.outputTokens, 42);
  });

  it('CLAUDE-03 a refusal becomes AnswerRefusedError; 5xx becomes retryable; 400 does not', async () => {
    const signal = new AbortController().signal;
    const refused = anthropicAnswerProvider('sk-test', 'claude-opus-5-5', { fetch: fakeFetch(200, sse(recorded('refusal'))).f });
    await assert.rejects(refused.answer(req, { signal, onEvent: () => undefined }), AnswerRefusedError);

    const err = (status: number) => JSON.stringify({ type: 'error', error: { type: 'api_error', message: `status ${status}` } });
    const down = anthropicAnswerProvider('sk-test', 'claude-opus-5-5', { fetch: fakeFetch(500, err(500)).f });
    await assert.rejects(down.answer(req, { signal, onEvent: () => undefined }), RetryableError);
    const bad = anthropicAnswerProvider('sk-test', 'claude-opus-5-5', { fetch: fakeFetch(400, err(400)).f });
    await assert.rejects(bad.answer(req, { signal, onEvent: () => undefined }), (e: unknown) => !(e instanceof RetryableError));
  });
});
