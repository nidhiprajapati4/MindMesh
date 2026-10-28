import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { client, emulatorToken, startTestApi } from './helpers';

let api: Awaited<ReturnType<typeof startTestApi>>;
let A: ReturnType<typeof client>;
let B: ReturnType<typeof client>;
let Note: typeof import('../models/Note').Note;
let links: typeof import('../modules/connections/links');

before(async () => {
  api = await startTestApi();
  A = client(api.base, emulatorToken('p6-user-a'));
  B = client(api.base, emulatorToken('p6-user-b'));
  ({ Note } = await import('../models/Note.js'));
  links = await import('../modules/connections/links.js');
});

after(async () => {
  await api?.stop();
});

type Created = { _id: string; outLinks: { key: string; title: string; noteId: string | null }[] };
const create = async (c: ReturnType<typeof client>, body: Record<string, unknown>) => {
  const r = await c.post('/api/notes', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as Created;
};
const linksOf = async (id: string, c = A) => (await c.get(`/api/connections/links/${id}`)).body as {
  outgoing: { title: string; state: string; note: { _id: string; title: string } | null }[];
  backlinks: { _id: string; title: string }[];
};
const backlinkIds = async (id: string) => (await linksOf(id)).backlinks.map((b) => b._id);

describe('Link parsing', () => {
  it('LINK-01 finds [[titles]], deduplicated, ignoring code and snippets', () => {
    const text = 'See [[Retry helper]] and [[ retry   HELPER ]] and [[Backoff]].\n```\n[[Not a link]]\n```\nAlso `[[inline code]]`, [[[Odd brackets]]] and [[]].';
    assert.deepEqual(links.parseLinks(text), [
      { key: 'retry helper', title: 'Retry helper' },
      { key: 'backoff', title: 'Backoff' },
      { key: 'odd brackets', title: 'Odd brackets' },
    ]);
    assert.deepEqual(links.parseLinks('[[Retry helper]]', 'snippet'), []);
    assert.deepEqual(links.parseLinks('no links here'), []);
  });

  it('LINK-02 keeps at most 100 links, and none across lines', () => {
    const many = Array.from({ length: 150 }, (_, i) => `[[Note ${i}]]`).join(' ');
    assert.equal(links.parseLinks(many).length, links.MAX_LINKS);
    assert.deepEqual(links.parseLinks('[[Split\nacross lines]]'), []);
  });
});

describe('Links between notes', () => {
  let target: Created;

  before(async () => {
    target = await create(A, { title: 'Retry helper', content: 'Exponential backoff with jitter.' });
  });

  it('LINK-03 a link resolves by title, whatever its case and spacing, and shows as a backlink', async () => {
    const source = await create(A, { title: 'HTTP client', content: 'Uses the [[retry   HELPER]] for flaky calls.' });
    assert.equal(source.outLinks[0].noteId, target._id);
    const out = await linksOf(source._id);
    assert.deepEqual(out.outgoing.map((o) => [o.title, o.state, o.note?._id]), [['retry HELPER', 'ok', target._id]]);
    assert.ok((await backlinkIds(target._id)).includes(source._id));
  });

  it('LINK-04 a link to a note that doesn’t exist yet starts working when that note is created', async () => {
    const source = await create(A, { title: 'Ideas', content: 'Write up [[Circuit breaker]] later.' });
    assert.deepEqual((await linksOf(source._id)).outgoing.map((o) => o.state), ['missing']);
    const later = await create(A, { title: 'Circuit Breaker', content: 'Stop calling a failing service for a while.' });
    assert.deepEqual((await linksOf(source._id)).outgoing.map((o) => [o.state, o.note?._id]), [['ok', later._id]]);
    assert.deepEqual(await backlinkIds(later._id), [source._id]);
  });

  it('LINK-05 with two notes of the same title, a link goes to the most recently updated', async () => {
    await create(A, { title: 'Weekly plan', content: 'Old plan.' });
    const newer = await create(A, { title: 'Weekly plan', content: 'New plan.' });
    const source = await create(A, { title: 'Monday', content: 'Follow the [[Weekly plan]].' });
    assert.equal(source.outLinks[0].noteId, newer._id);
  });

  it('LINK-06 renaming a note rewrites the links to it, without marking those notes as edited', async () => {
    const note = await create(A, { title: 'Deploy checklist', content: 'Steps before a release.' });
    const source = await create(A, { title: 'Release day', content: 'First the [[deploy  CHECKLIST]], then celebrate.' });
    const before = (await Note.findById(source._id).lean())!;

    const r = await A.patch(`/api/notes/${note._id}`, { title: 'Release checklist' });
    assert.equal(r.status, 200);
    const after = (await Note.findById(source._id).lean())!;
    assert.equal(after.content, 'First the [[Release checklist]], then celebrate.');
    assert.equal(String(after.outLinks[0].noteId), note._id);
    assert.equal(after.outLinks[0].key, 'release checklist');
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime(), 'updatedAt changed');
    assert.notEqual(after.contentHash, before.contentHash, 'the rewritten text is re-embedded');
    // …and the worker re-processing it doesn't mark it as edited either.
    await (await import('../modules/ai-processing/pipeline.js')).drain();
    const processed = (await Note.findById(source._id).lean())!;
    assert.equal(processed.processing?.status, 'ready');
    assert.equal(processed.updatedAt.getTime(), before.updatedAt.getTime(), 'processing changed updatedAt');
    // A note with the old title created later doesn't steal the link.
    await create(A, { title: 'Deploy checklist', content: 'A different note.' });
    assert.equal(String((await Note.findById(source._id).lean())!.outLinks[0].noteId), note._id);
  });

  it('LINK-07 editing the text updates the links; a tag-only edit leaves them alone', async () => {
    const source = await create(A, { title: 'Draft', content: 'Links to [[Retry helper]].' });
    await A.patch(`/api/notes/${source._id}`, { content: 'No links any more.' });
    assert.ok(!(await backlinkIds(target._id)).includes(source._id));
    await A.patch(`/api/notes/${source._id}`, { content: 'Back to [[Retry helper]].' });
    await A.patch(`/api/notes/${source._id}`, { tags: ['x'] });
    assert.ok((await backlinkIds(target._id)).includes(source._id));
    // Turning it into a snippet: brackets are code there.
    await A.patch(`/api/notes/${source._id}`, { type: 'snippet' });
    assert.ok(!(await backlinkIds(target._id)).includes(source._id));
  });

  it('LINK-08 trash hides links both ways, restore brings them back, delete forever makes them dangling', async () => {
    const t = await create(A, { title: 'Trash target', content: 'Something.' });
    const s = await create(A, { title: 'Trash source', content: 'See [[Trash target]].' });

    await A.del(`/api/notes/${s._id}`);
    assert.deepEqual(await backlinkIds(t._id), [], 'trashed note still listed as a backlink');
    await A.post(`/api/notes/${s._id}/restore`);
    assert.deepEqual(await backlinkIds(t._id), [s._id]);

    await A.del(`/api/notes/${t._id}`);
    assert.deepEqual((await linksOf(s._id)).outgoing.map((o) => o.state), ['trashed']);
    await A.post(`/api/notes/${t._id}/restore`);
    assert.deepEqual((await linksOf(s._id)).outgoing.map((o) => o.state), ['ok']);

    await A.del(`/api/notes/${t._id}`);
    await A.del(`/api/notes/${t._id}/permanent`);
    const src = (await Note.findById(s._id).lean())!;
    assert.equal(src.outLinks[0].noteId, null);
    // A new note with that title picks the link up.
    const again = await create(A, { title: 'Trash target', content: 'Recreated.' });
    assert.deepEqual(await backlinkIds(again._id), [s._id]);
  });

  it('LINK-09 the notes list shows how many notes link to each item', async () => {
    const r = await A.get('/api/notes?q=Retry%20helper');
    const item = r.body.items.find((n: { _id: string }) => n._id === target._id);
    const expected = (await backlinkIds(target._id)).length;
    assert.ok(expected >= 1);
    assert.equal(item.backlinkCount, expected);
  });
});

describe('Links are private', () => {
  it('LINK-10 a link never reaches another user’s note, and links are owner-only', async () => {
    const secret = await create(B, { title: 'B secret plan', content: 'Private.' });
    const source = await create(A, { title: 'Curious', content: 'Linking to [[B secret plan]].' });
    assert.equal(source.outLinks[0].noteId, null);
    assert.deepEqual((await linksOf(source._id)).outgoing.map((o) => [o.state, o.note]), [['missing', null]]);
    assert.deepEqual((await linksOf(secret._id, B)).backlinks, []);

    assert.equal((await B.get(`/api/connections/links/${source._id}`)).status, 404);
    assert.equal((await A.get('/api/connections/links/not-an-id')).status, 400);
    assert.equal((await client(api.base).get(`/api/connections/links/${source._id}`)).status, 401);
  });
});

describe('Existing notes', () => {
  it('LINK-11 notes saved before Phase 6 get their title key and links at startup', async () => {
    const t = await create(A, { title: 'Legacy target', content: 'Old.' });
    const s = await create(A, { title: 'Legacy source', content: 'Points at [[legacy target]].' });
    await Note.collection.updateMany({ _id: { $in: [t._id, s._id].map((id) => new (Note.base.Types.ObjectId)(id)) } }, { $unset: { titleKey: '', outLinks: '' } });

    const first = await links.backfillLinks();
    assert.ok(first.keyed >= 2 && first.linked >= 1, JSON.stringify(first));
    assert.deepEqual(await backlinkIds(t._id), [s._id]);
    assert.deepEqual(await links.backfillLinks(), { keyed: 0, linked: 0 }, 'safe to run again');
  });
});

describe('Graph', () => {
  let G: ReturnType<typeof client>;
  let H: ReturnType<typeof client>;
  let pipeline: typeof import('../modules/ai-processing/pipeline');
  let graph: typeof import('../modules/connections/graph');
  const ids: Record<string, string> = {};
  type Graph = { nodes: { id: string; degree: number; topicId: string | null }[]; edges: { source: string; target: string; kind: string; similar: number | null }[]; capped: boolean };
  const get = async (query = '', c = G) => {
    const r = await c.get(`/api/connections/graph${query}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body as Graph;
  };
  const edge = (g: Graph, a: string, b: string) => g.edges.find((e) => (e.source === ids[a] && e.target === ids[b]) || (e.source === ids[b] && e.target === ids[a]));

  before(async () => {
    G = client(api.base, emulatorToken('p6-graph-a'));
    H = client(api.base, emulatorToken('p6-graph-b'));
    pipeline = await import('../modules/ai-processing/pipeline.js');
    graph = await import('../modules/connections/graph.js');
    const folder = (await G.post('/api/folders', { name: 'Kitchen' })).body._id;
    const bread = 'Sourdough bread baking with a lively starter, flour, water and salt in a hot oven.';
    ids.bread1 = (await create(G, { title: 'Sourdough bread', content: bread, tags: ['baking'], folderId: folder }))._id;
    ids.bread2 = (await create(G, { title: 'Sourdough bread again', content: `${bread} See [[Sourdough bread]].`, tags: ['baking'], folderId: folder }))._id;
    ids.k8s = (await create(G, { title: 'Kubernetes probes', content: 'Liveness and readiness probes restart pods and gate traffic in the cluster. See [[Sourdough bread]].' }))._id;
    ids.lonely = (await create(G, { title: 'Volcano trip', content: 'Hiking near an active volcano in Iceland with lava fields and geysers.', type: 'idea' }))._id;
    ids.trashed = (await create(G, { title: 'Old bread', content: bread }))._id;
    await G.del(`/api/notes/${ids.trashed}`);
    ids.other = (await create(H, { title: 'Sourdough bread', content: bread }))._id;
    await pipeline.drain();
  });

  it('GRAPH-01 draws the user’s notes with link and similarity connections', async () => {
    const g = await get();
    const nodeIds = g.nodes.map((n) => n.id).sort();
    assert.deepEqual(nodeIds, [ids.bread1, ids.bread2, ids.k8s, ids.lonely].sort(), 'only active notes of this user');
    const both = edge(g, 'bread1', 'bread2')!;
    assert.equal(both.kind, 'link');
    assert.ok(both.similar! >= graph.graphSettings.similarMin, 'a linked, similar pair is one edge carrying its similarity');
    assert.equal(edge(g, 'k8s', 'bread1')?.kind, 'link');
    assert.equal(edge(g, 'k8s', 'bread1')?.similar, null);
    assert.ok(!g.edges.some((e) => e.source === ids.lonely || e.target === ids.lonely), 'unrelated note stays unconnected');
    assert.equal(g.nodes.find((n) => n.id === ids.bread1)!.degree, 2);
    assert.equal(g.capped, false);
  });

  it('GRAPH-02 filters by folder, tag and type, and can leave out similarity', async () => {
    assert.deepEqual((await get('?tag=baking')).nodes.map((n) => n.id).sort(), [ids.bread1, ids.bread2].sort());
    assert.deepEqual((await get('?type=idea')).nodes.map((n) => n.id), [ids.lonely]);
    assert.deepEqual((await get('?folder=none')).nodes.map((n) => n.id).sort(), [ids.k8s, ids.lonely].sort());
    const linksOnly = await get('?similar=0');
    assert.ok(linksOnly.edges.every((e) => e.kind === 'link' && e.similar === null));
    assert.equal(linksOnly.edges.length, 2);
  });

  it('GRAPH-03 follows changes: new notes appear, trashed notes and their connections go', async () => {
    const extra = await create(G, { title: 'Bread notes', content: 'Links to [[Volcano trip]].' });
    let g = await get();
    assert.ok(g.nodes.some((n) => n.id === extra._id));
    assert.ok(g.edges.some((e) => e.source === extra._id && e.target === ids.lonely));
    await G.del(`/api/notes/${extra._id}`);
    g = await get();
    assert.ok(!g.nodes.some((n) => n.id === extra._id));
    assert.ok(!g.edges.some((e) => e.source === extra._id || e.target === extra._id));
  });

  it('GRAPH-04 is private and validates its query', async () => {
    const other = await get('', H);
    assert.deepEqual(other.nodes.map((n) => n.id), [ids.other]);
    assert.equal((await G.get('/api/connections/graph?folder=bad')).status, 400);
    assert.equal((await G.get('/api/connections/graph?type=poem')).status, 400);
    assert.equal((await G.get('/api/connections/graph?hack=1')).status, 400);
    assert.equal((await client(api.base).get('/api/connections/graph')).status, 401);
  });

  it('GRAPH-05 each note keeps only its few most similar connections', () => {
    // Four notes along a line: each is most similar to its neighbours.
    const v = (x: number) => [Math.cos(x), Math.sin(x)];
    const notes = ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id, type: 'note', folderId: null, tags: [], linksTo: [] }));
    const lib = graph.makeLibrary(notes, new Map(notes.map((n, i) => [n.id, v(i * 0.2)])));
    const edges = (perNote: number) => graph.similarityEdges(lib, new Set([0, 1, 2, 3]), 0.5, perNote).map((p) => `${p.i}${p.j}`).sort();
    assert.deepEqual(edges(1), ['01', '12', '23']);
    assert.deepEqual(edges(3), ['01', '02', '03', '12', '13', '23']);
    assert.deepEqual(graph.similarityEdges(lib, new Set([0, 3]), 0.5, 3).map((p) => `${p.i}${p.j}`), ['03'], 'only included notes');
  });
});

describe('Topics', () => {
  let graph: typeof import('../modules/connections/graph');
  let topics: typeof import('../modules/connections/topics');
  before(async () => {
    graph = await import('../modules/connections/graph.js');
    topics = await import('../modules/connections/topics.js');
  });

  type N = { id: string; title: string; tags?: string[]; linksTo?: string[]; v: number[] | null };
  const lib = (ns: N[]) =>
    graph.makeLibrary(
      ns.map((n) => ({ id: n.id, title: n.title, type: 'note', folderId: null, tags: n.tags ?? [], linksTo: n.linksTo ?? [] })),
      new Map(ns.filter((n) => n.v).map((n) => [n.id, n.v!]))
    );
  // Unit vectors near one of three axes, slightly apart from each other.
  const near = (axis: number, k: number) => [0, 1, 2].map((a) => (a === axis ? 1 : 0.05 * k));

  it('TOPIC-01 groups similar notes, names them, and lists unconnected notes', () => {
    const t = topics.computeTopics(lib([
      { id: 'b1', title: 'Sourdough starter', tags: ['baking'], v: near(0, 1) },
      { id: 'b2', title: 'Bread hydration', tags: ['baking'], v: near(0, 2) },
      { id: 'b3', title: 'Dutch oven bread', tags: ['baking', 'oven'], v: near(0, 3) },
      { id: 'b4', title: 'Scoring the loaf', v: near(0, 4) },
      { id: 'k1', title: 'Kubernetes probes', v: near(1, 1) },
      { id: 'k2', title: 'Kubernetes limits', v: near(1, 2) },
      { id: 'k3', title: 'Rolling deploys in Kubernetes', v: near(1, 3) },
      { id: 'p1', title: 'Pair one', v: near(2, 1) },
      { id: 'p2', title: 'Pair two', v: near(2, 2) },
      { id: 'lonely', title: 'Unprocessed note', v: null },
    ]));
    assert.deepEqual(t.topics.map((x) => [x.name, x.noteIds.length]), [['baking', 4], ['kubernetes', 3]]);
    assert.ok(!t.topics.some((x) => x.noteIds.includes('p1')), 'a pair is too small to be a topic');
    assert.deepEqual(t.unconnected.map((n) => n.id), ['lonely']);
  });

  it('TOPIC-02 a long chain of similar notes is split instead of becoming one huge topic', () => {
    const chain = Array.from({ length: 12 }, (_, i) => ({ id: `c${i}`, title: `Chain ${i}`, v: [Math.cos(i * 0.3), Math.sin(i * 0.3)] }));
    const t = topics.computeTopics(lib(chain), { ...topics.topicSettings, topicMin: 0.9, maxSize: 4 });
    assert.ok(t.topics.length >= 2);
    assert.ok(t.topics.every((x) => x.noteIds.length <= 4 && x.noteIds.length >= 3));
  });

  it('TOPIC-03 [[links]] join loosely similar notes into a topic, but a hub never merges unrelated ones', () => {
    // x and y are 0.35 similar to the hub: below the topic bar alone, enough when linked.
    const loose = (sign: number) => [0.35, sign * Math.sqrt(1 - 0.35 ** 2), 0, 0];
    const t = topics.computeTopics(lib([
      { id: 'hub', title: 'Trip plan', linksTo: ['x', 'y'], v: [1, 0, 0, 0] },
      { id: 'x', title: 'Packing list', v: loose(1) },
      { id: 'y', title: 'Budget', v: loose(-1) },
      // An index note linking to notes about unrelated things.
      { id: 'index', title: 'Index', linksTo: ['u', 'w'], v: [0, 0, 1, 0] },
      { id: 'u', title: 'Unrelated one', v: [0, 0, 0, 1] },
      { id: 'w', title: 'Unrelated two', v: [0, 0, -0.1, 0.99] },
    ]));
    assert.deepEqual(t.topics.map((x) => x.noteIds.sort()), [['hub', 'x', 'y']]);
    assert.deepEqual(t.unconnected, [], 'linked notes count as connected');
    const unlinked = topics.computeTopics(lib([
      { id: 'hub', title: 'Trip plan', v: [1, 0, 0, 0] },
      { id: 'x', title: 'Packing list', v: loose(1) },
      { id: 'y', title: 'Budget', v: loose(-1) },
    ]));
    assert.deepEqual(unlinked.topics, [], 'without the links they are too far apart');
  });

  it('TOPIC-05 one borderline note can join a topic but cannot bridge two topics into one', () => {
    // Two tight groups along different axes, and one note 0.41 similar to a note in each.
    const t = topics.computeTopics(lib([
      { id: 'r1', title: 'Run one', v: [1, 0, 0, 0.05] },
      { id: 'r2', title: 'Run two', v: [1, 0, 0, 0.1] },
      { id: 'r3', title: 'Run three', v: [1, 0, 0, 0.15] },
      { id: 'k1', title: 'Kube one', v: [0, 1, 0, 0.05] },
      { id: 'k2', title: 'Kube two', v: [0, 1, 0, 0.1] },
      { id: 'k3', title: 'Kube three', v: [0, 1, 0, 0.15] },
      { id: 'bridge', title: 'Load testing', v: [0.42, 0.42, 0.8, 0] },
    ]));
    const groups = t.topics.map((x) => x.noteIds.sort().join(','));
    assert.equal(t.topics.length, 2, JSON.stringify(groups));
    assert.ok(!t.topics.some((x) => x.noteIds.includes('r1') && x.noteIds.includes('k1')), 'running and kubernetes merged');
  });

  it('TOPIC-04 the topics endpoint and graph agree, follow edits and stay private', async () => {
    const G = client(api.base, emulatorToken('p6-graph-a'));
    const r = await G.get('/api/connections/topics');
    assert.equal(r.status, 200);
    const baking = r.body.topics.find((x: { name: string }) => x.name === 'baking');
    assert.ok(baking, JSON.stringify(r.body));
    assert.equal(baking.size, 3, 'two similar bread notes plus the note linking to them');
    assert.ok(r.body.unconnected.some((n: { title: string }) => n.title === 'Volcano trip'));

    const g = (await G.get('/api/connections/graph')).body as { nodes: { id: string; topicId: string | null }[] };
    for (const id of baking.noteIds) assert.equal(g.nodes.find((n) => n.id === id)?.topicId, baking.id);

    await G.patch(`/api/notes/${r.body.unconnected.find((n: { title: string }) => n.title === 'Volcano trip')._id}`, { content: 'See [[Sourdough bread]] for the picnic.' });
    const after = (await G.get('/api/connections/topics')).body;
    assert.ok(!after.unconnected.some((n: { title: string }) => n.title === 'Volcano trip'), 'the edit is reflected: it is linked now');
    assert.equal(after.topics.find((x: { name: string }) => x.name === 'baking')?.size, 3, 'a link alone doesn’t pull an unrelated note into the topic');

    const other = (await client(api.base, emulatorToken('p6-graph-b')).get('/api/connections/topics')).body;
    assert.ok(!JSON.stringify(other).includes(baking.id));
    assert.equal((await client(api.base).get('/api/connections/topics')).status, 401);
  });
});
