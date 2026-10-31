import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { client, emulatorToken, startTestApi } from './helpers';

// Imported after startTestApi() has pointed the app at the throwaway database; importing app code
// earlier would read the real MONGODB_URI from apps/api/.env.
let parseLibraryQuestion: typeof import('../modules/ask/library').parseLibraryQuestion;
let api: Awaited<ReturnType<typeof startTestApi>>;
let A: ReturnType<typeof client>;
let B: ReturnType<typeof client>;
const tokenA = emulatorToken('p8-user-a');

before(async () => {
  api = await startTestApi();
  ({ parseLibraryQuestion } = await import('../modules/ask/library.js'));
  A = client(api.base, tokenA);
  B = client(api.base, emulatorToken('p8-user-b'));
});

after(async () => {
  await api?.stop();
});

type SseEvent = { event: string; data: any };

/** Asks a question and returns the streamed events. */
async function ask(token: string, body: Record<string, unknown>) {
  const res = await fetch(`${api.base}/api/ask`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  const events: SseEvent[] = raw
    .split('\n\n')
    .filter(Boolean)
    .map((chunk) => ({ event: /^event: (.*)$/m.exec(chunk)?.[1] ?? '', data: JSON.parse(/^data: (.*)$/m.exec(chunk)?.[1] ?? 'null') }));
  return { status: res.status, events };
}
const textOf = (events: SseEvent[]) => events.filter((e) => e.event === 'text').map((e) => e.data.text).join('');

describe('Favourites (F6)', () => {
  it('FAV-01: items start as not favourite, and can be starred and unstarred', async () => {
    const created = await A.post('/api/notes', { title: 'Plain note', content: 'text' });
    assert.equal(created.status, 201);
    assert.equal(created.body.favourite, false);
    const starred = await A.patch(`/api/notes/${created.body._id}`, { favourite: true });
    assert.equal(starred.body.favourite, true);
    const back = await A.patch(`/api/notes/${created.body._id}`, { favourite: false });
    assert.equal(back.body.favourite, false);
  });

  it('FAV-02: the list can be limited to favourites, and older notes without the field still list', async () => {
    const star = await A.post('/api/notes', { title: 'Starred', content: 'x', favourite: true });
    await A.post('/api/notes', { title: 'Not starred', content: 'y' });
    const { Note } = await import('../models/Note.js');
    // An item saved before favourites existed has no such field.
    await Note.collection.updateOne({ title: 'Not starred' }, { $unset: { favourite: '' } });
    const favs = await A.get('/api/notes?favourite=true');
    assert.deepEqual(favs.body.items.map((n: { title: string }) => n.title), ['Starred']);
    assert.equal(favs.body.items[0]._id, star.body._id);
    const all = await A.get('/api/notes?limit=100');
    assert.ok(all.body.items.some((n: { title: string }) => n.title === 'Not starred'));
  });
});

describe('Counts (F5)', () => {
  it('CNT-01: counts items by view, type, tag and favourite', async () => {
    const c = client(api.base, emulatorToken('p8-counts'));
    const snippet = await c.post('/api/notes', { type: 'snippet', title: 'S', content: 'code', tags: ['dev'] });
    await c.post('/api/notes', { type: 'idea', title: 'I', content: 'idea', tags: ['dev', 'x'], favourite: true });
    const archived = await c.post('/api/notes', { title: 'Old', content: 'old', archived: true });
    const trashed = await c.post('/api/notes', { title: 'Gone', content: 'gone' });
    await c.del(`/api/notes/${trashed.body._id}`);
    assert.ok(snippet.body._id && archived.body._id);

    const r = await c.get('/api/notes/counts');
    assert.equal(r.status, 200);
    assert.equal(r.body.all, 2);
    assert.equal(r.body.archived, 1);
    assert.equal(r.body.trash, 1);
    assert.equal(r.body.favourites, 1);
    assert.deepEqual(r.body.types, { note: 0, snippet: 1, url: 0, idea: 1, document: 0 });
    assert.deepEqual(r.body.tags, { dev: 2, x: 1 });
    assert.equal(r.body.conversations, 0);
    assert.equal(r.body.saved, 0);
    assert.equal(r.body.duplicates, undefined);
  });

  it('CNT-02: ?duplicates=1 also counts possible duplicate pairs, and counts are private', async () => {
    const r = await A.get('/api/notes/counts?duplicates=1');
    assert.equal(typeof r.body.duplicates, 'number');
    const other = await B.get('/api/notes/counts');
    assert.equal(other.body.all, 0);
  });
});

describe('Questions about the library (F3)', () => {
  const folders = [{ id: 'f1', name: 'Work' }];
  const now = new Date('2026-10-30T12:00:00');

  it('LIB-01: recognises casual library questions', () => {
    for (const q of [
      'how many notes i have added till now',
      'How many notes do I have?',
      'number of documents',
      'how many links do i have',
      'list my documents',
      'show my latest 5 notes',
      'how many notes are tagged #test',
      'how many items in folder Work',
      'how many archived notes',
      'what did I add last',
      'how many notes did I add this week',
    ]) {
      assert.ok(parseLibraryQuestion(q, folders, now), q);
    }
  });

  it('LIB-02: leaves questions about what the notes say to normal search', () => {
    for (const q of ['How do I roll back a failed deployment?', 'what is hydration in sourdough', 'how many pods should a deployment run', 'show me notes about kubernetes', 'how many notes mention probes']) {
      assert.equal(parseLibraryQuestion(q, folders, now), null, q);
    }
  });

  it('LIB-03: reads types, tags, folders, states and time ranges', () => {
    const i = parseLibraryQuestion('how many documents tagged #test are in folder work and archived added this month', folders, now)!;
    assert.deepEqual(i.types, ['document']);
    assert.equal(i.tag, 'test');
    assert.deepEqual(i.folder, folders[0]);
    assert.equal(i.view, 'archived');
    assert.equal(i.since?.label, 'this month');
    assert.equal(parseLibraryQuestion('show my latest 3 notes', [], now)!.limit, 3);
    assert.equal(parseLibraryQuestion('what did I add last', [], now)!.limit, 1);
  });

  it('LIB-04: answers counts and lists from the database, with links to the items', async () => {
    const c = client(api.base, emulatorToken('p8-library'));
    const tok = emulatorToken('p8-library');
    await c.post('/api/notes', { title: 'Test', content: 'Test Description', tags: ['test'] });
    await c.post('/api/notes', { type: 'url', title: 'A link', sourceUrl: 'https://example.com/a', content: '' });
    await c.post('/api/notes', { type: 'snippet', title: 'A snippet', content: 'let a = 1' });

    const total = await ask(tok, { question: 'how many notes i have added till now' });
    assert.equal(total.status, 200);
    assert.match(textOf(total.events), /You have 3 items in total: 1 note, 1 snippet, 1 link, 0 ideas, 0 documents\. 0 archived, 0 in trash\./);

    const links = await ask(tok, { question: 'how many links do I have?' });
    assert.match(textOf(links.events), /You have 1 link\./);
    assert.ok(links.events.some((e) => e.event === 'citation'));

    const tagged = await ask(tok, { question: 'how many notes are tagged #test' });
    assert.match(textOf(tagged.events), /1 item tagged #test/);

    const none = await ask(tok, { question: 'how many documents do I have' });
    assert.match(textOf(none.events), /don’t have any documents/);

    const latest = await ask(tok, { question: 'show my latest 2 notes' });
    const done = latest.events.find((e) => e.event === 'done')!.data;
    assert.equal(done.turn.status, 'complete');
    assert.equal(done.turn.sources.length, 2);
    assert.equal(done.turn.model, 'library');
  });
});

describe('Saved answers (F2)', () => {
  it('SAV-01: saves an answer, lists it, reopens it, and un-saves it', async () => {
    const tok = emulatorToken('p8-saver');
    const c = client(api.base, tok);
    await c.post('/api/notes', { title: 'One', content: 'first note' });
    const asked = await ask(tok, { question: 'how many notes do I have' });
    const done = asked.events.find((e) => e.event === 'done')!.data;

    const saved = await c.post('/api/saved', { conversationId: done.conversationId, turnIndex: done.turnIndex });
    assert.equal(saved.status, 201);
    const again = await c.post('/api/saved', { conversationId: done.conversationId, turnIndex: done.turnIndex });
    assert.equal(again.body._id, saved.body._id, 'saving twice keeps one bookmark');

    const list = await c.get('/api/saved');
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].question, 'how many notes do I have');
    assert.equal(list.body[0].conversationId, done.conversationId);

    const one = await c.get(`/api/saved/${saved.body._id}`);
    assert.match(one.body.segments[0].text, /You have 1 item in total/);

    assert.equal((await c.get('/api/notes/counts')).body.saved, 1);
    assert.equal((await c.del(`/api/saved/${saved.body._id}`)).status, 204);
    assert.equal((await c.get('/api/saved')).body.length, 0);
    assert.equal((await c.del(`/api/saved/${saved.body._id}`)).status, 404);
  });

  it('SAV-02: a saved answer survives deleting its conversation, and is private', async () => {
    const tok = emulatorToken('p8-saver2');
    const c = client(api.base, tok);
    const done = (await ask(tok, { question: 'how many notes do I have' })).events.find((e) => e.event === 'done')!.data;
    const saved = await c.post('/api/saved', { conversationId: done.conversationId, turnIndex: done.turnIndex });
    await c.del(`/api/conversations/${done.conversationId}`);
    assert.equal((await c.get(`/api/saved/${saved.body._id}`)).status, 200);
    assert.equal((await B.get(`/api/saved/${saved.body._id}`)).status, 404);
    assert.equal((await B.post('/api/saved', { conversationId: done.conversationId, turnIndex: 0 })).status, 404);
    assert.equal((await c.post('/api/saved', { conversationId: done.conversationId, turnIndex: 9 })).status, 404);
  });
});

describe('Profile (F7)', () => {
  it('PRO-01: shows the account email and empty optional fields', async () => {
    const r = await A.get('/api/profile');
    assert.equal(r.status, 200);
    assert.equal(r.body.email, 'p8-user-a@example.test');
    assert.deepEqual([r.body.phone, r.body.dob, r.body.birthLocation], ['', '', '']);
  });

  it('PRO-02: saves name, phone, date of birth and birth location, and clears them', async () => {
    const saved = await A.patch('/api/profile', { displayName: ' Test User ', phone: '+91 98765-43210', dob: '1995-04-12', birthLocation: 'Pune, India' });
    assert.equal(saved.status, 200);
    assert.deepEqual(
      [saved.body.displayName, saved.body.phone, saved.body.dob, saved.body.birthLocation],
      ['Test User', '+91 98765-43210', '1995-04-12', 'Pune, India']
    );
    assert.equal((await A.get('/api/profile')).body.dob, '1995-04-12');
    const cleared = await A.patch('/api/profile', { phone: '', dob: '' });
    assert.deepEqual([cleared.body.phone, cleared.body.dob], ['', '']);
    assert.equal(cleared.body.displayName, 'Test User', 'fields not sent are left alone');
  });

  it('PRO-03: the email cannot be changed through the API', async () => {
    const r = await A.patch('/api/profile', { email: 'someone-else@example.com' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
    assert.equal((await A.get('/api/profile')).body.email, 'p8-user-a@example.test');
  });

  it('PRO-04: rejects a bad phone number and a future or impossible date of birth', async () => {
    assert.equal((await A.patch('/api/profile', { phone: 'call me maybe' })).status, 400);
    assert.equal((await A.patch('/api/profile', { dob: '2999-01-01' })).status, 400);
    assert.equal((await A.patch('/api/profile', { dob: '1850-01-01' })).status, 400);
    assert.equal((await A.patch('/api/profile', { dob: '12/04/1995' })).status, 400);
  });

  it('PRO-05: profiles are per user', async () => {
    await A.patch('/api/profile', { birthLocation: 'Only A' });
    assert.equal((await B.get('/api/profile')).body.birthLocation, '');
  });
});

describe('Edge cases and validation', () => {
  it('EDG-01: a non-boolean favourite is rejected', async () => {
    const n = await A.post('/api/notes', { title: 'Edge', content: 'x' });
    const r = await A.patch(`/api/notes/${n.body._id}`, { favourite: 'yes' });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
  });

  it('EDG-02: a trashed favourite no longer appears in the favourites list', async () => {
    const n = await A.post('/api/notes', { title: 'Soon trashed', content: 'x', favourite: true });
    await A.del(`/api/notes/${n.body._id}`);
    const favs = await A.get('/api/notes?favourite=true');
    assert.ok(!favs.body.items.some((i: { _id: string }) => i._id === n.body._id));
  });

  it('EDG-03: counts, saved answers and profile need a signed-in user', async () => {
    for (const path of ['/api/notes/counts', '/api/saved', '/api/profile']) {
      const res = await fetch(`${api.base}${path}`);
      assert.equal(res.status, 401, path);
    }
  });

  it('EDG-04: saving an answer from a conversation that does not exist is a 404, and a bad body a 400', async () => {
    const missing = await A.post('/api/saved', { conversationId: '64b000000000000000000000', turnIndex: 0 });
    assert.equal(missing.status, 404);
    const bad = await A.post('/api/saved', { conversationId: 'nope', turnIndex: -1 });
    assert.equal(bad.status, 400);
  });

  it('EDG-05: another user cannot open or delete a saved answer', async () => {
    const asked = await ask(tokenA, { question: 'how many notes do i have' });
    const conversationId = asked.events.find((e) => e.event === 'done')!.data.conversationId;
    const saved = await A.post('/api/saved', { conversationId, turnIndex: 0 });
    assert.ok([200, 201].includes(saved.status));
    assert.equal((await B.get(`/api/saved/${saved.body._id}`)).status, 404);
    assert.equal((await B.del(`/api/saved/${saved.body._id}`)).status, 404);
    assert.equal((await A.get(`/api/saved/${saved.body._id}`)).status, 200);
  });

  it('EDG-06: the profile rejects unknown fields and over-long values', async () => {
    assert.equal((await A.patch('/api/profile', { isAdmin: true })).status, 400);
    assert.equal((await A.patch('/api/profile', { birthLocation: 'x'.repeat(101) })).status, 400);
  });

  it('EDG-07: ordinary chatter is not mistaken for a library question', () => {
    for (const q of ['hello', 'thanks', 'what is the capital of France']) {
      assert.equal(parseLibraryQuestion(q, [], now0), null, q);
    }
  });
});
const now0 = new Date('2026-10-30T12:00:00');
