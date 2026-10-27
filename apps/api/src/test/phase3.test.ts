import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { client, emulatorToken, startTestApi } from './helpers';

let api: Awaited<ReturnType<typeof startTestApi>>;
let A: ReturnType<typeof client>;
let B: ReturnType<typeof client>;
let userA: string;

// Loaded after startTestApi() so they share its env and database connection.
let pipeline: typeof import('../modules/ai-processing/pipeline');
let jobs: typeof import('../modules/ai-processing/jobs');
let aiClient: typeof import('../platform/ai-client');
let Chunk: typeof import('../models/Chunk').Chunk;
let Note: typeof import('../models/Note').Note;
let ProcessingJob: typeof import('../models/ProcessingJob').ProcessingJob;
let Usage: typeof import('../models/Usage').Usage;
let fakeProvider: typeof import('../platform/embeddings/fake').fakeProvider;
let RetryableError: typeof import('../platform/embeddings/types').RetryableError;

before(async () => {
  api = await startTestApi();
  A = client(api.base, emulatorToken('p3-user-a'));
  B = client(api.base, emulatorToken('p3-user-b'));
  userA = (await A.get('/api/me')).body.userId;
  await B.get('/api/me');
  pipeline = await import('../modules/ai-processing/pipeline.js');
  jobs = await import('../modules/ai-processing/jobs.js');
  aiClient = await import('../platform/ai-client.js');
  ({ Chunk } = await import('../models/Chunk.js'));
  ({ Note } = await import('../models/Note.js'));
  ({ ProcessingJob } = await import('../models/ProcessingJob.js'));
  ({ Usage } = await import('../models/Usage.js'));
  ({ fakeProvider } = await import('../platform/embeddings/fake.js'));
  ({ RetryableError } = await import('../platform/embeddings/types.js'));
});

after(async () => {
  await api?.stop();
});

beforeEach(() => aiClient.setEmbeddingProvider(null));

const HOUR = 60 * 60 * 1000;
const later = (ms: number) => new Date(Date.now() + ms);

const create = async (c: ReturnType<typeof client>, body: Record<string, unknown>) => {
  const r = await c.post('/api/notes', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};
const search = (c: ReturnType<typeof client>, q: string, mode = 'hybrid', extra = '') =>
  c.get(`/api/search?q=${encodeURIComponent(q)}&mode=${mode}${extra}`);
const titles = (r: { body: { items: { note: { title: string } }[] } }) => r.body.items.map((i) => i.note.title);
const status = async (id: string) => (await Note.findById(id).lean())!.processing?.status;

describe('Queueing and the worker', () => {
  it('P3-01 a new note is queued, and the worker makes it ready with chunks', async () => {
    const n = await create(A, { title: 'Retry helper', content: 'Use exponential backoff with jitter for flaky network calls.' });
    assert.equal(n.processing.status, 'pending');
    assert.ok(n.contentHash);
    assert.equal(await ProcessingJob.countDocuments({ noteId: n._id, status: 'pending' }), 1);

    assert.ok((await pipeline.drain()).includes('ready'));
    assert.equal(await status(n._id), 'ready');
    const chunks = await Chunk.find({ noteId: n._id }).lean();
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].model, fakeProvider.model);
    assert.equal(chunks[0].embedding.length, fakeProvider.dims);
    assert.match(chunks[0].text, /^Retry helper\n\n/);
    assert.equal((await ProcessingJob.findOne({ noteId: n._id }).lean())!.status, 'ready');
  });

  it('P3-02 only content changes re-queue; pin, tags and folder do not', async () => {
    const n = await create(A, { title: 'Stable', content: 'unchanged words' });
    await pipeline.drain();
    for (const patch of [{ pinned: true }, { tags: ['x'] }, { archived: false }]) {
      const r = await A.patch(`/api/notes/${n._id}`, patch);
      assert.equal(r.body.processing.status, 'ready', JSON.stringify(patch));
    }
    const edited = await A.patch(`/api/notes/${n._id}`, { content: 'brand new words' });
    assert.equal(edited.body.processing.status, 'pending');
    await pipeline.drain();
    const [chunk] = await Chunk.find({ noteId: n._id }).lean();
    assert.match(chunk.text, /brand new words/);
  });

  it('P3-03 an empty item is marked skipped and gets no job', async () => {
    const n = await create(A, { title: '', content: '' });
    assert.equal(n.processing.status, 'skipped');
    assert.equal(await ProcessingJob.countDocuments({ noteId: n._id }), 0);
  });

  it('P3-04 a long note becomes several chunks', async () => {
    const content = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} about distributed systems and consensus protocols like Raft and Paxos.`).join('\n\n');
    const n = await create(A, { title: 'Consensus notes', content });
    await pipeline.drain();
    assert.ok((await Chunk.countDocuments({ noteId: n._id })) > 1);
  });

  it('P3-05 an edit during processing discards the stale result', async () => {
    const n = await create(A, { title: 'Race', content: 'first version' });
    const claimed = await jobs.claimNext();
    assert.equal(String(claimed!.noteId), n._id);
    await A.patch(`/api/notes/${n._id}`, { content: 'second version' }); // re-queues with a new hash
    assert.equal(await pipeline.runJob(claimed as never), 'stale');
    assert.equal(await Chunk.countDocuments({ noteId: n._id }), 0, 'stale vectors were written');
    await pipeline.drain();
    const [chunk] = await Chunk.find({ noteId: n._id }).lean();
    assert.match(chunk.text, /second version/);
  });

  it('P3-06 link items never fetch private addresses (SSRF) but still get indexed from their description', async () => {
    const n = await create(A, { type: 'url', title: 'Internal page', sourceUrl: 'http://127.0.0.1/admin', metadata: { description: 'Router settings page' } });
    await pipeline.drain();
    assert.equal(await status(n._id), 'ready');
    const [chunk] = await Chunk.find({ noteId: n._id }).lean();
    assert.equal(chunk.text, 'Internal page\n\nRouter settings page');
  });

  it('P3-07 notes saved before Phase 3 are backfilled', async () => {
    const { insertedId } = await Note.collection.insertOne({
      userId: new (await import('mongoose')).Types.ObjectId(userA), type: 'note', title: 'Old note', content: 'from phase two',
      tags: [], folderId: null, sourceUrl: null, metadata: {}, pinned: false, archived: false, deletedAt: null,
    });
    assert.equal(await jobs.backfill({ _id: insertedId, processing: null }), 1);
    await pipeline.drain();
    assert.equal(await status(String(insertedId)), 'ready');
  });
});

describe('Failures and retries', () => {
  const failing = (err: () => Error) => ({ ...fakeProvider, embed: async () => { throw err(); } });

  it('P3-10 a transient provider error is retried inside the AI client', async () => {
    let calls = 0;
    aiClient.setEmbeddingProvider({
      ...fakeProvider,
      embed: async (texts, signal) => {
        if (++calls === 1) throw new RetryableError('503 from provider');
        return fakeProvider.embed(texts, signal);
      },
    });
    const n = await create(A, { title: 'Flaky provider', content: 'eventually works' });
    await pipeline.drain();
    assert.equal(calls, 2);
    assert.equal(await status(n._id), 'ready');
  });

  it('P3-11 a failing job backs off, fails after 3 attempts, and Retry recovers it', async () => {
    aiClient.setEmbeddingProvider(failing(() => new Error('model exploded')));
    const n = await create(A, { title: 'Doomed', content: 'will fail' });

    assert.deepEqual(await pipeline.drain(), ['retry']);
    let job = (await ProcessingJob.findOne({ noteId: n._id }).lean())!;
    assert.equal(job.attempts, 1);
    assert.ok(job.runAfter > new Date(), 'retry is scheduled in the future');
    assert.equal(await status(n._id), 'pending');
    assert.deepEqual(await pipeline.drain(), [], 'not retried before its time');

    // An hour later both remaining retries are due: attempt 2 fails and reschedules, attempt 3 gives up.
    assert.deepEqual(await pipeline.drain(later(HOUR)), ['retry', 'failed']);
    job = (await ProcessingJob.findOne({ noteId: n._id }).lean())!;
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 3);
    assert.match(job.lastError!, /model exploded/);
    const failed = (await A.get(`/api/notes/${n._id}`)).body;
    assert.equal(failed.processing.status, 'failed');
    assert.ok(failed.processing.error && !/exploded/.test(failed.processing.error), 'user sees a friendly message, not internals');

    aiClient.setEmbeddingProvider(null);
    const retried = await A.post(`/api/notes/${n._id}/reprocess`);
    assert.equal(retried.status, 200);
    assert.equal(retried.body.processing.status, 'pending');
    await pipeline.drain();
    assert.equal(await status(n._id), 'ready');
  });

  it('P3-12 reprocess is owner-scoped and validates ids', async () => {
    const n = await create(A, { title: 'Mine', content: 'private' });
    assert.equal((await B.post(`/api/notes/${n._id}/reprocess`)).status, 404);
    assert.equal((await A.post('/api/notes/not-an-id/reprocess')).status, 400);
    await pipeline.drain();
  });

  it('P3-13 a job stuck in processing (crashed worker) is reclaimed after the lock timeout', async () => {
    const n = await create(A, { title: 'Crashed worker', content: 'left behind' });
    await jobs.claimNext(); // claimed, then the "worker" dies
    assert.equal(await jobs.claimNext(), null, 'not reclaimed while the lock is fresh');
    const reclaimed = await jobs.claimNext(later(jobs.LOCK_TIMEOUT_MS + 1000));
    assert.equal(String(reclaimed!.noteId), n._id);
    assert.equal(await pipeline.runJob(reclaimed as never), 'ready');
  });
});

describe('Search', () => {
  let retry: { _id: string };
  let revenue: { _id: string };

  before(async () => {
    retry = await create(A, { title: 'Exponential backoff', content: 'When a network request fails, wait longer before each retry and add jitter.', tags: ['backend'] });
    revenue = await create(A, { title: 'Quarterly report', content: 'Revenue grew twelve percent and churn fell.', type: 'document' });
    await create(B, { title: 'B secret backoff', content: 'User B network retry notes with jitter.' });
    await pipeline.drain();
  });

  it('S-01 semantic search returns the matching item with a snippet', async () => {
    const r = await search(A, 'retrying failed network requests', 'semantic');
    assert.equal(r.status, 200);
    assert.equal(r.body.mode, 'semantic');
    const hit = r.body.items.find((i: { note: { _id: string } }) => i.note._id === retry._id);
    assert.ok(hit, JSON.stringify(titles(r)));
    assert.equal(hit.matchedBy, 'meaning');
    assert.match(hit.snippet, /network request fails/);
    assert.ok(!hit.snippet.startsWith('Exponential backoff'), 'snippet repeats the title');
    assert.ok(!titles(r).includes('Quarterly report'));
  });

  it('S-02 hybrid marks items found both ways and ranks them first', async () => {
    const r = await search(A, 'backoff jitter');
    assert.equal(r.status, 200);
    // Earlier tests also created a "Retry helper" note with both words, so either may come first;
    // what matters is that items found both ways lead the list and are labelled as such.
    const both = r.body.items.filter((i: { matchedBy: string }) => i.matchedBy === 'both');
    assert.ok(both.some((i: { note: { _id: string } }) => i.note._id === retry._id));
    assert.deepEqual(r.body.items.slice(0, both.length), both, 'an item matched only one way outranks one matched both ways');
  });

  it('S-03 keyword mode matches words only and has no snippets', async () => {
    const r = await search(A, 'revenue', 'keyword');
    assert.deepEqual(titles(r), ['Quarterly report']);
    assert.equal(r.body.items[0].matchedBy, 'keyword');
    assert.equal(r.body.items[0].snippet, null);
  });

  it('S-04 user B never sees user A’s items (and vice versa)', async () => {
    for (const mode of ['semantic', 'hybrid', 'keyword']) {
      const b = await search(B, 'backoff jitter network retry', mode);
      assert.ok(b.body.items.every((i: { note: { title: string } }) => i.note.title === 'B secret backoff'), `${mode}: ${titles(b)}`);
      const a = await search(A, 'backoff jitter network retry', mode);
      assert.ok(!titles(a).includes('B secret backoff'), mode);
    }
  });

  it('S-05 filters apply to meaning search', async () => {
    assert.deepEqual(titles(await search(A, 'retry network jitter', 'semantic', '&type=document')), []);
    assert.deepEqual(titles(await search(A, 'retry network jitter', 'semantic', '&tag=backend')), ['Exponential backoff']);
  });

  it('S-06 trashed and archived items disappear from search; restore brings them back', async () => {
    const n = await create(A, { title: 'Kubernetes probes', content: 'Liveness and readiness probes for pods.' });
    await pipeline.drain();
    assert.ok(titles(await search(A, 'readiness probes pods', 'semantic')).includes('Kubernetes probes'));

    await A.del(`/api/notes/${n._id}`);
    assert.equal(await Chunk.countDocuments({ noteId: n._id }), 0, 'chunks removed on trash');
    assert.ok(!titles(await search(A, 'readiness probes pods', 'semantic')).includes('Kubernetes probes'));

    const restored = await A.post(`/api/notes/${n._id}/restore`);
    assert.equal(restored.body.processing.status, 'pending');
    await pipeline.drain();
    assert.ok(titles(await search(A, 'readiness probes pods', 'semantic')).includes('Kubernetes probes'));

    await A.patch(`/api/notes/${n._id}`, { archived: true });
    assert.ok(!titles(await search(A, 'readiness probes pods', 'semantic')).includes('Kubernetes probes'));
  });

  it('S-07 permanent delete and empty trash remove chunks and jobs', async () => {
    const n1 = await create(A, { title: 'Temp one', content: 'temporary' });
    const n2 = await create(A, { title: 'Temp two', content: 'temporary' });
    await pipeline.drain();
    await A.del(`/api/notes/${n1._id}`);
    await A.del(`/api/notes/${n1._id}/permanent`);
    await A.del(`/api/notes/${n2._id}`);
    await A.del('/api/notes/trash');
    for (const id of [n1._id, n2._id]) {
      assert.equal(await Chunk.countDocuments({ noteId: id }), 0);
      assert.equal(await ProcessingJob.countDocuments({ noteId: id }), 0);
    }
  });

  it('S-08 validates the query', async () => {
    assert.equal((await A.get('/api/search')).status, 400);
    assert.equal((await A.get('/api/search?q=%20%20')).status, 400);
    assert.equal((await A.get('/api/search?q=x&mode=magic')).status, 400);
    assert.equal((await A.get('/api/search?q=x&limit=500')).status, 400);
    assert.equal((await client(api.base).get('/api/search?q=x')).status, 401);
  });

  it('S-09 meaning search fails cleanly when the model is down; hybrid falls back to keywords', async () => {
    aiClient.setEmbeddingProvider({ ...fakeProvider, embed: async () => { throw new Error('model offline'); } });
    const semantic = await search(A, 'revenue', 'semantic');
    assert.equal(semantic.status, 503);
    assert.equal(semantic.body.code, 'SEMANTIC_UNAVAILABLE');
    const hybrid = await search(A, 'revenue');
    assert.equal(hybrid.status, 200);
    assert.deepEqual(titles(hybrid), ['Quarterly report']);
    assert.match(hybrid.body.warning, /unavailable/);
  });
});

describe('Daily AI budget', () => {
  it('Q-01 usage is counted per user per day', async () => {
    const r = await A.get('/api/search/usage');
    assert.equal(r.status, 200);
    assert.ok(r.body.embedTokens > 0);
    assert.ok(r.body.requests > 0);
    assert.equal(r.body.budget, 200000);
  });

  it('Q-02 over budget: semantic search returns 429 QUOTA_EXCEEDED, hybrid degrades, processing fails clearly', async () => {
    const C = client(api.base, emulatorToken('p3-user-c'));
    const userC = (await C.get('/api/me')).body.userId;
    const n = await create(C, { title: 'Budget note', content: 'budget words' });
    await Usage.updateOne({ userId: userC, day: new Date().toISOString().slice(0, 10) }, { $set: { embedTokens: 200000 } }, { upsert: true });

    const semantic = await search(C, 'budget', 'semantic');
    assert.equal(semantic.status, 429);
    assert.equal(semantic.body.code, 'QUOTA_EXCEEDED');

    const hybrid = await search(C, 'budget');
    assert.equal(hybrid.status, 200);
    assert.match(hybrid.body.warning, /budget/i);
    assert.deepEqual(titles(hybrid), ['Budget note']);

    assert.deepEqual(await pipeline.drain(), ['failed'], 'quota errors are not retried');
    assert.match((await C.get(`/api/notes/${n._id}`)).body.processing.error, /budget/i);

    // Other users are unaffected.
    assert.equal((await search(A, 'revenue', 'semantic')).status, 200);
  });
});
