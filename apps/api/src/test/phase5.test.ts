import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { client, emulatorToken, startTestApi } from './helpers';

let api: Awaited<ReturnType<typeof startTestApi>>;
let A: ReturnType<typeof client>;
let B: ReturnType<typeof client>;
let pipeline: typeof import('../modules/ai-processing/pipeline');
let jobs: typeof import('../modules/ai-processing/jobs');
let NoteVector: typeof import('../models/NoteVector').NoteVector;
let Note: typeof import('../models/Note').Note;
let Usage: typeof import('../models/Usage').Usage;

before(async () => {
  api = await startTestApi();
  A = client(api.base, emulatorToken('p5-user-a'));
  B = client(api.base, emulatorToken('p5-user-b'));
  pipeline = await import('../modules/ai-processing/pipeline.js');
  jobs = await import('../modules/ai-processing/jobs.js');
  ({ NoteVector } = await import('../models/NoteVector.js'));
  ({ Note } = await import('../models/Note.js'));
  ({ Usage } = await import('../models/Usage.js'));
});

after(async () => {
  await api?.stop();
});

const create = async (c: ReturnType<typeof client>, body: Record<string, unknown>) => {
  const r = await c.post('/api/notes', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as { _id: string };
};
const hasVector = async (id: string) => !!(await NoteVector.exists({ noteId: id }));

// Notes about bread share many words, so the word-based test embedder rates them as similar.
const BREAD = [
  { title: 'Sourdough bread baking', content: 'Sourdough bread baking needs a lively starter, flour, water and salt. Bake the bread in a hot oven.' },
  { title: 'Baking sourdough bread at home', content: 'Bread baking at home: feed the sourdough starter with flour and water, then bake the bread hot.' },
  { title: 'Sourdough bread starter baking', content: 'A sourdough starter of flour and water makes the bread rise. Bake sourdough bread when the starter doubles.' },
];

describe('Note vectors', () => {
  it('ORG-01 written when a note is processed, removed on trash and delete, rebuilt on restore', async () => {
    const n = await create(A, { title: 'Vector lifecycle', content: 'Some text to embed for the vector lifecycle test.' });
    assert.equal(await hasVector(n._id), false, 'before processing');
    await pipeline.drain();
    assert.equal(await hasVector(n._id), true);
    await A.del(`/api/notes/${n._id}`);
    assert.equal(await hasVector(n._id), false, 'trash removes it');
    await A.post(`/api/notes/${n._id}/restore`);
    await pipeline.drain();
    assert.equal(await hasVector(n._id), true, 'restore rebuilds it');
    await A.del(`/api/notes/${n._id}`);
    await A.del(`/api/notes/${n._id}/permanent`);
    assert.equal(await hasVector(n._id), false, 'delete forever removes it');
  });

  it('ORG-02 notes processed before Phase 5 get a vector from their stored chunks, without re-embedding', async () => {
    const n = await create(A, { title: 'Old note', content: 'Embedded before note vectors existed.' });
    await pipeline.drain();
    await NoteVector.deleteOne({ noteId: n._id }); // as if processed by Phase 4
    assert.ok((await jobs.backfillNoteVectors()) >= 1);
    assert.equal(await hasVector(n._id), true);
    assert.equal(await jobs.backfillNoteVectors(), 0, 'safe to run again');
  });
});

describe('Related notes', () => {
  const ids: string[] = [];
  let unrelated: { _id: string };

  before(async () => {
    for (const b of BREAD) ids.push((await create(A, { ...b, tags: ['baking'] }))._id);
    unrelated = await create(A, { title: 'Kubernetes probes', content: 'Liveness and readiness probes restart pods and gate traffic in the cluster.' });
    await create(B, { ...BREAD[0], title: 'B private sourdough bread baking' });
    await pipeline.drain();
  });

  it('ORG-03 lists similar notes, never the note itself, unrelated notes or another user’s notes', async () => {
    const r = await A.get(`/api/organize/related/${ids[0]}`);
    assert.equal(r.status, 200);
    const found = r.body.items.map((i: { note: { _id: string } }) => i.note._id);
    assert.ok(found.includes(ids[1]) && found.includes(ids[2]), JSON.stringify(r.body));
    assert.ok(!found.includes(ids[0]), 'itself');
    assert.ok(!found.includes(unrelated._id), 'unrelated note');
    assert.ok(r.body.items.every((i: { note: { title: string } }) => !i.note.title.startsWith('B private')), 'another user’s note');
    assert.ok(r.body.items[0].note.preview, 'preview included');
    assert.equal(r.body.items[0].note.embedding, undefined);
  });

  it('ORG-04 trashed notes are not related; unprocessed notes say so; access is owner-only', async () => {
    await A.del(`/api/notes/${ids[2]}`);
    const r = await A.get(`/api/organize/related/${ids[0]}`);
    assert.ok(!r.body.items.some((i: { note: { _id: string } }) => i.note._id === ids[2]));
    await A.post(`/api/notes/${ids[2]}/restore`);
    assert.equal((await A.get(`/api/organize/related/${ids[2]}`)).body.pending, true, 'restored but not re-processed yet');
    await pipeline.drain();

    assert.equal((await B.get(`/api/organize/related/${ids[0]}`)).status, 404);
    assert.equal((await A.get('/api/organize/related/not-an-id')).status, 400);
    assert.equal((await client(api.base).get(`/api/organize/related/${ids[0]}`)).status, 401);
  });
});

describe('Suggestions while writing', () => {
  let folderId: string;
  before(async () => {
    folderId = (await A.post('/api/folders', { name: 'Kitchen' })).body._id;
    for (const b of BREAD) await create(A, { ...b, title: `${b.title} (filed)`, tags: ['baking', 'bread'], folderId });
    await pipeline.drain();
  });

  const suggest = (body: Record<string, unknown>, c = A) => c.post('/api/organize/suggest', body);
  const draft = { title: 'Weekend sourdough bread', content: 'Baking sourdough bread with a starter, flour and water; bake the bread in a hot oven.' };

  it('ORG-05 suggests the tags and folder that similar notes use', async () => {
    const r = await suggest(draft);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.tags.map((t: { tag: string }) => t.tag).sort(), ['baking', 'bread']);
    assert.equal(r.body.folder?.name, 'Kitchen');
  });

  it('ORG-05b unfiled similar notes do not outvote a folder; disagreeing folders give no suggestion', async () => {
    // ORG-05 already runs with three unfiled bread notes (from the related-notes tests) among the neighbours.
    const other = (await A.post('/api/folders', { name: 'Recipes' })).body._id;
    for (const b of BREAD) await create(A, { ...b, title: `${b.title} (recipes)`, tags: ['baking'], folderId: other });
    await pipeline.drain();
    const r = await suggest(draft);
    assert.equal(r.body.folder, null, 'Kitchen and Recipes are split evenly, so neither should be suggested');
  });

  it('ORG-06 never suggests tags the draft already has, or a folder when one is chosen', async () => {
    const r = await suggest({ ...draft, tags: ['baking'], folderId });
    assert.deepEqual(r.body.tags.map((t: { tag: string }) => t.tag), ['bread']);
    assert.equal(r.body.folder, null);
  });

  it('ORG-07 stays quiet for a draft unlike anything saved, or too short to judge', async () => {
    const unique = await suggest({ title: 'Volcano trip', content: 'Hiking near an active volcano in Iceland with lava fields and geysers.' });
    assert.deepEqual(unique.body, { tags: [], folder: null, duplicates: [] });
    const short = await suggest({ title: 'Bread', content: '' });
    assert.deepEqual(short.body, { tags: [], folder: null, duplicates: [] });
  });

  it('ORG-08 suggestions only learn from the same user’s notes', async () => {
    const r = await suggest(draft, B);
    assert.deepEqual(r.body.tags, []);
    assert.equal(r.body.folder, null);
  });
});

describe('Duplicates', () => {
  let original: { _id: string };
  let link: { _id: string };

  before(async () => {
    original = await create(A, { title: 'Retry policy for HTTP calls', content: 'Wrap outbound HTTP requests in exponential backoff with jitter and cap retries at five attempts.' });
    link = await create(A, { type: 'url', title: 'Example article', sourceUrl: 'https://www.example.com/article/' });
    await pipeline.drain();
  });

  it('ORG-09 warns while writing a near-copy, but not about the note being edited', async () => {
    const r = await A.post('/api/organize/suggest', { title: 'Retry policy for HTTP calls', content: 'Wrap outbound HTTP requests in exponential backoff with jitter; cap retries at five attempts.' });
    const dup = r.body.duplicates.find((d: { _id: string }) => d._id === original._id);
    assert.ok(dup, JSON.stringify(r.body.duplicates));
    assert.equal(dup.reason, 'similar');
    assert.ok(dup.score >= 0.9);
    const self = await A.post('/api/organize/suggest', { title: 'Retry policy for HTTP calls', content: 'Wrap outbound HTTP requests in exponential backoff with jitter and cap retries at five attempts.', noteId: original._id });
    assert.ok(!self.body.duplicates.some((d: { _id: string }) => d._id === original._id));
  });

  it('ORG-10 the same link saved again is a duplicate, however it is written', async () => {
    const r = await A.post('/api/organize/suggest', { title: '', content: '', sourceUrl: 'http://example.com/article#top' });
    assert.deepEqual(r.body.duplicates.map((d: { _id: string; reason: string }) => [d._id, d.reason]), [[link._id, 'same-link']]);
  });

  it('ORG-11 the duplicates view pairs near-copies and repeated links, owner only', async () => {
    const copy = await create(A, { title: 'Retry policy for HTTP calls (copy)', content: 'Wrap outbound HTTP requests in exponential backoff with jitter and cap retries at five attempts.' });
    const link2 = await create(A, { type: 'url', title: 'Same article again', sourceUrl: 'https://example.com/article' });
    await pipeline.drain();
    const r = await A.get('/api/organize/duplicates');
    assert.equal(r.status, 200);
    const pairs = r.body.pairs.map((p: { a: { _id: string }; b: { _id: string }; reason: string }) => [[p.a._id, p.b._id].sort().join(':'), p.reason]);
    assert.ok(pairs.some(([k, why]: string[]) => k === [original._id, copy._id].sort().join(':') && why === 'similar'));
    assert.ok(pairs.some(([k, why]: string[]) => k === [link._id, link2._id].sort().join(':') && why === 'same-link'));

    const b = await B.get('/api/organize/duplicates');
    assert.ok(!JSON.stringify(b.body).includes(original._id), 'another user sees A’s notes');

    await A.del(`/api/notes/${copy._id}`);
    const after = await A.get('/api/organize/duplicates');
    assert.ok(!JSON.stringify(after.body).includes(copy._id), 'trashed notes are not listed');
  });
});

describe('Key points', () => {
  const long = [
    'The onboarding redesign started in March because users dropped out at step two.',
    'The new flow asks only for an email and a workspace name.',
    'Conversion rose from nine percent to fourteen percent after six weeks.',
    'Support tickets about signup fell by half.',
    'The team will run a usability session every two weeks.',
    'Shipping the progress indicator first would have helped most.',
  ].join(' ');

  it('ORG-12 long notes get 2–3 of their own sentences; short notes get none', async () => {
    const n = await create(A, { title: 'Onboarding retrospective', content: long });
    const short = await create(A, { title: 'Short', content: 'Just one sentence here. And another.' });
    await pipeline.drain();
    const points = (await A.get(`/api/notes/${n._id}`)).body.keyPoints as string[];
    assert.ok(points.length >= 2 && points.length <= 3, JSON.stringify(points));
    for (const p of points) assert.ok(long.includes(p), `not one of the note's sentences: ${p}`);
    assert.deepEqual((await A.get(`/api/notes/${short._id}`)).body.keyPoints, []);
  });

  it('ORG-13 recomputed when the text changes, not when only tags change', async () => {
    const n = await create(A, { title: 'Changing note', content: long });
    await pipeline.drain();
    await A.patch(`/api/notes/${n._id}`, { tags: ['retro'] });
    assert.deepEqual(await pipeline.drain(), [], 'a tag edit re-processed the note');
    await A.patch(`/api/notes/${n._id}`, { content: 'Now it is short. Very short.' });
    await pipeline.drain();
    assert.deepEqual((await Note.findById(n._id).lean())!.keyPoints, []);
  });
});

describe('Validation and limits', () => {
  it('ORG-14 validates input, requires sign-in and respects the daily AI budget', async () => {
    assert.equal((await A.post('/api/organize/suggest', { title: 'x', hack: true })).status, 400);
    assert.equal((await A.post('/api/organize/suggest', { title: 'x'.repeat(201) })).status, 400);
    assert.equal((await A.post('/api/organize/suggest', { title: 'ok', noteId: 'bad' })).status, 400);
    assert.equal((await client(api.base).post('/api/organize/suggest', { title: 'x' })).status, 401);
    assert.equal((await client(api.base).get('/api/organize/duplicates')).status, 401);

    const C = client(api.base, emulatorToken('p5-user-c'));
    const userC = (await C.get('/api/me')).body.userId;
    await Usage.updateOne({ userId: userC, day: new Date().toISOString().slice(0, 10) }, { $set: { embedTokens: 200_000 } }, { upsert: true });
    const r = await C.post('/api/organize/suggest', { title: 'Sourdough bread baking', content: 'Long enough draft text to be embedded for suggestions.' });
    assert.equal(r.status, 429);
    assert.equal(r.body.code, 'QUOTA_EXCEEDED');
  });
});
