import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { client, emulatorToken, makeDocx, makePdf, startTestApi } from './helpers';

let api: Awaited<ReturnType<typeof startTestApi>>;
let A: ReturnType<typeof client>; // user A
let B: ReturnType<typeof client>; // user B (must never see A's data)
let anon: ReturnType<typeof client>;

before(async () => {
  api = await startTestApi();
  A = client(api.base, emulatorToken('user-a'));
  B = client(api.base, emulatorToken('user-b'));
  anon = client(api.base);
});

after(async () => {
  await api?.stop();
});

const note = async (body: Record<string, unknown>) => {
  const r = await A.post('/api/notes', body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body;
};

describe('Authentication', () => {
  it('AUTH-01 rejects requests without a token', async () => {
    assert.equal((await anon.get('/api/notes')).status, 401);
    assert.equal((await anon.get('/api/folders')).status, 401);
  });

  it('AUTH-02 rejects malformed or forged tokens', async () => {
    assert.equal((await client(api.base, 'not-a-token').get('/api/notes')).status, 401);
    const wrongProject = emulatorToken('x').replace(/^[^.]+\.[^.]+/, (m) => {
      const [h, p] = m.split('.');
      const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
      payload.aud = 'someone-elses-project';
      return `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    });
    assert.equal((await client(api.base, wrongProject).get('/api/notes')).status, 401);
  });

  it('AUTH-03 health and /api/me work', async () => {
    assert.equal((await anon.get('/health')).status, 200);
    const me = await A.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.body.uid, 'user-a');
  });
});

describe('Notes CRUD and validation', () => {
  it('NOTE-01 creates a note with Phase 2 defaults', async () => {
    const n = await note({ title: '  Hello  ', content: 'World' });
    assert.equal(n.title, 'Hello');
    assert.equal(n.type, 'note');
    assert.equal(n.folderId, null);
    assert.equal(n.deletedAt, null);
  });

  it('NOTE-02 supports every item type', async () => {
    for (const type of ['note', 'snippet', 'url', 'idea', 'document']) {
      assert.equal((await note({ title: `t-${type}`, type })).type, type);
    }
  });

  it('NOTE-03 normalises tags (lowercase, trimmed, de-duplicated)', async () => {
    assert.deepEqual((await note({ title: 'tags', tags: ['JS', ' js ', 'Node'] })).tags, ['js', 'node']);
  });

  it('NOTE-04 rejects invalid input', async () => {
    assert.equal((await A.post('/api/notes', { title: 'x'.repeat(201) })).status, 400);
    assert.equal((await A.post('/api/notes', { type: 'video' })).status, 400);
    assert.equal((await A.post('/api/notes', { sourceUrl: 'javascript:alert(1)' })).status, 400);
    assert.equal((await A.post('/api/notes', { userId: '000000000000000000000000' })).status, 400, 'client cannot set owner');
    assert.equal((await A.post('/api/notes', { metadata: { fileName: 'fake.pdf' } })).status, 400, 'file metadata is server-only');
    assert.equal((await A.post('/api/notes', { tags: Array.from({ length: 21 }, (_, i) => `t${i}`) })).status, 400);
  });

  it('NOTE-05 rejects malformed JSON and bad ids', async () => {
    const res = await fetch(`${api.base}/api/notes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emulatorToken('user-a')}`, 'Content-Type': 'application/json' },
      body: '{bad json',
    });
    assert.equal(res.status, 400);
    assert.equal((await A.get('/api/notes/not-an-id')).status, 400);
    assert.equal((await A.get('/api/notes/000000000000000000000000')).status, 404);
  });

  it('NOTE-06 edits a note (title, content, type, tags, source URL)', async () => {
    const n = await note({ title: 'Draft', content: 'v1' });
    const r = await A.patch(`/api/notes/${n._id}`, { title: 'Final', content: 'v2', type: 'idea', tags: ['Plan'], sourceUrl: 'https://example.com' });
    assert.equal(r.status, 200);
    assert.equal(r.body.title, 'Final');
    assert.equal(r.body.content, 'v2');
    assert.equal(r.body.type, 'idea');
    assert.deepEqual(r.body.tags, ['plan']);
    assert.equal(r.body.sourceUrl, 'https://example.com');
    const cleared = await A.patch(`/api/notes/${n._id}`, { sourceUrl: null });
    assert.equal(cleared.body.sourceUrl, null);
    assert.equal((await A.get(`/api/notes/${n._id}`)).body.title, 'Final');
  });

  it('NOTE-07 edits metadata field by field (empty string clears)', async () => {
    const n = await note({ title: 'Snip', type: 'snippet', metadata: { language: 'ts', author: 'Dana' } });
    const r = await A.patch(`/api/notes/${n._id}`, { metadata: { language: 'go', author: '' } });
    assert.equal(r.body.metadata.language, 'go');
    assert.equal(r.body.metadata.author, undefined);
  });

  it('NOTE-08 pins and archives', async () => {
    const n = await note({ title: 'Pin me' });
    assert.equal((await A.patch(`/api/notes/${n._id}`, { pinned: true })).body.pinned, true);
    assert.equal((await A.patch(`/api/notes/${n._id}`, { archived: true })).body.archived, true);
    const active = await A.get('/api/notes?limit=100');
    assert.ok(!active.body.items.some((i: any) => i._id === n._id), 'archived note hidden from active view');
    const archived = await A.get('/api/notes?view=archived');
    assert.ok(archived.body.items.some((i: any) => i._id === n._id));
    // Phase 1 query style still works
    assert.ok((await A.get('/api/notes?archived=true')).body.items.some((i: any) => i._id === n._id));
  });
});

describe('Ownership isolation', () => {
  it('ISO-01 user B cannot read, edit, trash, restore or delete user A’s note', async () => {
    const n = await note({ title: 'A secret' });
    assert.equal((await B.get(`/api/notes/${n._id}`)).status, 404);
    assert.equal((await B.patch(`/api/notes/${n._id}`, { title: 'hacked' })).status, 404);
    assert.equal((await B.del(`/api/notes/${n._id}`)).status, 404);
    await A.del(`/api/notes/${n._id}`);
    assert.equal((await B.post(`/api/notes/${n._id}/restore`)).status, 404);
    assert.equal((await B.del(`/api/notes/${n._id}/permanent`)).status, 404);
    assert.equal((await A.post(`/api/notes/${n._id}/restore`)).status, 200, 'A still owns it');
    assert.equal((await A.get(`/api/notes/${n._id}`)).body.title, 'A secret');
  });

  it('ISO-02 lists, search, tags and folders never include another user’s data', async () => {
    await note({ title: 'zebra unique-a-word', tags: ['a-only'] });
    await A.post('/api/folders', { name: 'A folder' });
    const list = await B.get('/api/notes?limit=100');
    assert.equal(list.body.total, 0);
    assert.equal((await B.get('/api/notes?q=zebra')).body.total, 0);
    assert.deepEqual((await B.get('/api/notes/tags')).body, []);
    assert.deepEqual((await B.get('/api/folders')).body.folders, []);
    await B.del('/api/notes/trash');
    assert.ok((await A.get('/api/notes?q=zebra')).body.total >= 1, 'B emptying trash does not touch A');
  });

  it('ISO-03 user B cannot use, rename or delete user A’s folder', async () => {
    const f = (await A.post('/api/folders', { name: 'Private' })).body;
    assert.equal((await B.post('/api/notes', { title: 'x', folderId: f._id })).status, 404);
    assert.equal((await B.patch(`/api/folders/${f._id}`, { name: 'Mine now' })).status, 404);
    assert.equal((await B.del(`/api/folders/${f._id}`)).status, 404);
    const bNote = (await B.post('/api/notes', { title: 'b' })).body;
    assert.equal((await B.patch(`/api/notes/${bNote._id}`, { folderId: f._id })).status, 404);
  });
});

describe('Folders', () => {
  it('FOLD-01 creates, lists alphabetically and counts items', async () => {
    const f = (await A.post('/api/folders', { name: 'Research' })).body;
    await note({ title: 'in research', folderId: f._id });
    await note({ title: 'in research 2', folderId: f._id });
    const r = await A.get('/api/folders');
    const research = r.body.folders.find((x: any) => x.name === 'Research');
    assert.equal(research.noteCount, 2);
    const names = r.body.folders.map((x: any) => x.name.toLowerCase());
    assert.deepEqual(names, [...names].sort());
    assert.equal(typeof r.body.unfiledCount, 'number');
  });

  it('FOLD-02 rejects duplicate names case-insensitively, and empty/long names', async () => {
    await A.post('/api/folders', { name: 'Work' });
    assert.equal((await A.post('/api/folders', { name: 'work' })).status, 409);
    assert.equal((await A.post('/api/folders', { name: '   ' })).status, 400);
    assert.equal((await A.post('/api/folders', { name: 'x'.repeat(61) })).status, 400);
    assert.equal((await B.post('/api/folders', { name: 'Work' })).status, 201, 'other users may reuse the name');
  });

  it('FOLD-03 renames a folder; rename to an existing name is rejected', async () => {
    const f = (await A.post('/api/folders', { name: 'Old name' })).body;
    const r = await A.patch(`/api/folders/${f._id}`, { name: 'New name' });
    assert.equal(r.status, 200);
    assert.equal(r.body.name, 'New name');
    await A.post('/api/folders', { name: 'Taken' });
    assert.equal((await A.patch(`/api/folders/${f._id}`, { name: 'TAKEN' })).status, 409);
    assert.equal((await A.patch(`/api/folders/${f._id}`, { name: 'new NAME' })).status, 200, 'case change of own name is allowed');
  });

  it('FOLD-04 deleting a folder keeps its items as unfiled', async () => {
    const f = (await A.post('/api/folders', { name: 'Temp' })).body;
    const n = await note({ title: 'survivor', folderId: f._id });
    assert.equal((await A.del(`/api/folders/${f._id}`)).status, 204);
    const after = await A.get(`/api/notes/${n._id}`);
    assert.equal(after.status, 200);
    assert.equal(after.body.folderId, null);
    assert.equal((await A.del(`/api/folders/${f._id}`)).status, 404);
  });

  it('FOLD-05 moves a note between folders and to unfiled', async () => {
    const f1 = (await A.post('/api/folders', { name: 'Move 1' })).body;
    const f2 = (await A.post('/api/folders', { name: 'Move 2' })).body;
    const n = await note({ title: 'mover', folderId: f1._id });
    assert.equal((await A.patch(`/api/notes/${n._id}`, { folderId: f2._id })).body.folderId, f2._id);
    assert.equal((await A.patch(`/api/notes/${n._id}`, { folderId: null })).body.folderId, null);
    assert.equal((await A.patch(`/api/notes/${n._id}`, { folderId: '000000000000000000000000' })).status, 404);
  });
});

describe('Search, filters, sorting, pagination', () => {
  let u: ReturnType<typeof client>;
  let folderId: string;

  before(async () => {
    u = client(api.base, emulatorToken('user-search'));
    folderId = (await u.post('/api/folders', { name: 'Search folder' })).body._id;
    const make = (b: Record<string, unknown>) => u.post('/api/notes', b);
    await make({ title: 'Retry strategy', content: 'Use exponential backoff with jitter', tags: ['backend'], folderId });
    await make({ title: 'apple pie', content: 'Recipe', type: 'idea' });
    await make({ title: 'Banana bread', content: 'Another recipe', type: 'idea', tags: ['food'] });
    await make({ title: 'useEffect cleanup', content: 'return () => clearTimeout(t)', type: 'snippet', metadata: { language: 'ts' } });
    await make({ title: 'Pinned thing', pinned: true });
  });

  it('SRCH-01 full-text search ranks title matches', async () => {
    const r = await u.get('/api/notes?q=retry&sort=relevance');
    assert.equal(r.body.matchMode, 'text');
    assert.equal(r.body.items[0].title, 'Retry strategy');
  });

  it('SRCH-02 finds words in content and stemmed forms', async () => {
    assert.equal((await u.get('/api/notes?q=backoff')).body.total, 1);
    assert.equal((await u.get('/api/notes?q=recipes')).body.total, 2, 'stemming: recipes → recipe');
  });

  it('SRCH-03 falls back to partial-word matching', async () => {
    const r = await u.get('/api/notes?q=retr');
    assert.equal(r.body.matchMode, 'partial');
    assert.equal(r.body.items[0].title, 'Retry strategy');
    assert.equal((await u.get('/api/notes?q=a.b*c(')).status, 200, 'regex characters are escaped');
  });

  it('SRCH-04 filters by type, folder, unfiled, tag and pinned', async () => {
    assert.equal((await u.get('/api/notes?type=idea')).body.total, 2);
    assert.equal((await u.get('/api/notes?type=snippet')).body.items[0].metadata.language, 'ts');
    assert.equal((await u.get(`/api/notes?folder=${folderId}`)).body.total, 1);
    assert.equal((await u.get('/api/notes?folder=none')).body.total, 4);
    assert.equal((await u.get('/api/notes?tag=food')).body.total, 1);
    assert.equal((await u.get('/api/notes?pinned=true')).body.total, 1);
    assert.equal((await u.get('/api/notes?type=idea&q=banana')).body.total, 1, 'filters combine with search');
    assert.equal((await u.get('/api/notes?type=movie')).status, 400);
  });

  it('SRCH-05 sorts pinned first, then by title case-insensitively', async () => {
    const r = await u.get('/api/notes?sort=title');
    const titles = r.body.items.map((i: any) => i.title);
    assert.equal(titles[0], 'Pinned thing');
    assert.deepEqual(titles.slice(1), ['apple pie', 'Banana bread', 'Retry strategy', 'useEffect cleanup']);
    assert.equal((await u.get('/api/notes')).body.items[0].title, 'Pinned thing', 'default sort: pinned first');
  });

  it('SRCH-06 paginates with page/limit and caps limit at 100', async () => {
    const p1 = await u.get('/api/notes?limit=2&page=1');
    const p3 = await u.get('/api/notes?limit=2&page=3');
    assert.equal(p1.body.total, 5);
    assert.equal(p1.body.items.length, 2);
    assert.equal(p3.body.items.length, 1);
    assert.equal((await u.get('/api/notes?limit=101')).status, 400);
  });

  it('SRCH-07 filters by date range', async () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    assert.equal((await u.get(`/api/notes?from=${future}`)).body.total, 0);
    assert.equal((await u.get(`/api/notes?to=${future}`)).body.total, 5);
  });

  it('SRCH-08 tag list is sorted and excludes archived/trashed items', async () => {
    assert.deepEqual((await u.get('/api/notes/tags')).body, ['backend', 'food']);
  });
});

describe('Trash', () => {
  let t: ReturnType<typeof client>;
  before(() => {
    t = client(api.base, emulatorToken('user-trash'));
  });

  it('TRASH-01 delete moves to trash; restore brings it back', async () => {
    const n = (await t.post('/api/notes', { title: 'oops', tags: ['gone'] })).body;
    const del = await t.del(`/api/notes/${n._id}`);
    assert.equal(del.status, 200);
    assert.ok(del.body.deletedAt);
    assert.equal((await t.get('/api/notes')).body.total, 0);
    assert.equal((await t.get('/api/notes?view=trash')).body.total, 1);
    assert.deepEqual((await t.get('/api/notes/tags')).body, [], 'trashed tags hidden');
    assert.equal((await t.post(`/api/notes/${n._id}/restore`)).status, 200);
    assert.equal((await t.get('/api/notes')).body.total, 1);
  });

  it('TRASH-02 trashed items cannot be edited or trashed twice', async () => {
    const n = (await t.post('/api/notes', { title: 'locked' })).body;
    await t.del(`/api/notes/${n._id}`);
    assert.equal((await t.patch(`/api/notes/${n._id}`, { title: 'x' })).status, 404);
    assert.equal((await t.del(`/api/notes/${n._id}`)).status, 404);
  });

  it('TRASH-03 permanent delete works only from the trash', async () => {
    const n = (await t.post('/api/notes', { title: 'forever' })).body;
    assert.equal((await t.del(`/api/notes/${n._id}/permanent`)).status, 404, 'must be trashed first');
    await t.del(`/api/notes/${n._id}`);
    assert.equal((await t.del(`/api/notes/${n._id}/permanent`)).status, 204);
    assert.equal((await t.get(`/api/notes/${n._id}`)).status, 404);
  });

  it('TRASH-04 empty trash deletes only trashed items', async () => {
    await t.del('/api/notes/trash'); // start from an empty trash
    const keep = (await t.post('/api/notes', { title: 'keep' })).body;
    for (const title of ['x1', 'x2']) {
      const n = (await t.post('/api/notes', { title })).body;
      await t.del(`/api/notes/${n._id}`);
    }
    const r = await t.del('/api/notes/trash');
    assert.equal(r.status, 200);
    assert.equal(r.body.deleted, 2);
    assert.equal((await t.get('/api/notes?view=trash')).body.total, 0);
    assert.equal((await t.get(`/api/notes/${keep._id}`)).status, 200);
  });

  it('TRASH-05 trashing unpins the item', async () => {
    const n = (await t.post('/api/notes', { title: 'pinned', pinned: true })).body;
    assert.equal((await t.del(`/api/notes/${n._id}`)).body.pinned, false);
  });
});

describe('File upload', () => {
  it('UPL-01 plain text file becomes a document item', async () => {
    const r = await A.upload('meeting_notes.txt', 'Agenda\r\n\r\n\r\n\r\nShip phase 2');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.type, 'document');
    assert.equal(r.body.title, 'meeting notes');
    assert.equal(r.body.content, 'Agenda\n\nShip phase 2');
    assert.equal(r.body.metadata.fileName, 'meeting_notes.txt');
    assert.equal(r.body.metadata.mimeType, 'text/plain');
    assert.equal(r.body.metadata.fileSize, Buffer.byteLength('Agenda\r\n\r\n\r\n\r\nShip phase 2'));
  });

  it('UPL-02 markdown uses the first heading as title', async () => {
    const r = await A.upload('readme.md', '# Retry Guide\n\nUse backoff.');
    assert.equal(r.status, 201);
    assert.equal(r.body.title, 'Retry Guide');
    assert.equal(r.body.metadata.mimeType, 'text/markdown');
  });

  it('UPL-03 PDF text is extracted with page count', async () => {
    const r = await A.upload('report.pdf', makePdf(['Quarterly report', 'Revenue grew 12 percent']));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.match(r.body.content, /Quarterly report/);
    assert.match(r.body.content, /Revenue grew 12 percent/);
    assert.doesNotMatch(r.body.content, /-- 1 of 1 --/);
    assert.equal(r.body.metadata.pageCount, 1);
    assert.equal(r.body.metadata.mimeType, 'application/pdf');
  });

  it('UPL-04 Word .docx text is extracted', async () => {
    const r = await A.upload('Design Doc.docx', await makeDocx(['Architecture', 'Use a modular monolith']));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.title, 'Design Doc');
    assert.match(r.body.content, /Architecture\s+Use a modular monolith/);
  });

  it('UPL-05 uploaded document is searchable', async () => {
    await A.upload('kafka.txt', 'Consumer groups rebalance partitions');
    const r = await A.get('/api/notes?q=rebalance');
    assert.equal(r.body.items[0].metadata.fileName, 'kafka.txt');
  });

  it('UPL-06 accepts folder and tags fields', async () => {
    const f = (await A.post('/api/folders', { name: 'Uploads' })).body;
    const r = await A.upload('tagged.txt', 'hello', { folderId: f._id, tags: 'Docs, docs, work' });
    assert.equal(r.status, 201);
    assert.equal(r.body.folderId, f._id);
    assert.deepEqual(r.body.tags, ['docs', 'work']);
    assert.equal((await A.upload('t.txt', 'x', { folderId: '' })).status, 201, 'empty folderId = unfiled');
    assert.equal((await B.upload('t.txt', 'x', { folderId: f._id })).status, 404, 'cannot upload into another user’s folder');
  });

  it('UPL-07 rejects unsupported types and disguised files', async () => {
    assert.equal((await A.upload('photo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))).status, 415);
    assert.equal((await A.upload('script.exe', 'MZ')).status, 415);
    assert.equal((await A.upload('fake.pdf', 'just text')).status, 415, 'PDF extension but not a PDF');
    assert.equal((await A.upload('fake.docx', 'just text')).status, 415);
    assert.equal((await A.upload('binary.txt', Buffer.from([0x41, 0x00, 0x42]))).status, 415);
    assert.equal((await A.upload('latin1.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))).status, 415, 'non-UTF-8 text');
  });

  it('UPL-08 rejects empty, broken and oversized files', async () => {
    assert.equal((await A.upload('empty.txt', '')).status, 422);
    assert.equal((await A.upload('blank.txt', '   \n\n ')).status, 422);
    assert.equal((await A.upload('broken.pdf', '%PDF-1.4 garbage')).status, 422);
    assert.equal((await A.upload('broken.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).status, 422);
    const big = await A.upload('big.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 'a'));
    assert.equal(big.status, 413);
    assert.match(big.body.error, /10 MB/);
  });

  it('UPL-09 requires a file in the "file" field', async () => {
    const empty = await A.post('/api/notes/upload', new FormData());
    assert.equal(empty.status, 400);
    const form = new FormData();
    form.append('document', new Blob(['x']), 'x.txt');
    assert.equal((await A.post('/api/notes/upload', form)).status, 400);
    assert.equal((await anon.upload('x.txt', 'x')).status, 401);
  });

  it('UPL-10 keeps non-ASCII file names intact', async () => {
    const r = await A.upload('résumé—notes.txt', 'café');
    assert.equal(r.body.metadata.fileName, 'résumé—notes.txt');
    assert.equal(r.body.content, 'café');
  });

  it('UPL-11 cuts very long text at 50,000 characters and flags it', async () => {
    const r = await A.upload('long.txt', 'word '.repeat(20000));
    assert.equal(r.status, 201);
    assert.equal(r.body.content.length, 50000);
    assert.equal(r.body.metadata.truncated, true);
  });

  it('UPL-12 editing an uploaded document keeps its file details', async () => {
    const doc = (await A.upload('keep.pdf', makePdf(['Keep me']))).body;
    const r = await A.patch(`/api/notes/${doc._id}`, { title: 'Renamed doc', content: 'edited', metadata: { description: 'summary' } });
    assert.equal(r.status, 200);
    assert.equal(r.body.title, 'Renamed doc');
    assert.equal(r.body.metadata.fileName, 'keep.pdf');
    assert.equal(r.body.metadata.pageCount, 1);
    assert.equal(r.body.metadata.description, 'summary');
  });
});

describe('URL capture', () => {
  it('CAP-01 refuses to fetch private addresses but still saves the link', async () => {
    const r = await A.post('/api/notes/capture-url', { url: 'http://169.254.169.254/latest/meta-data' });
    assert.equal(r.status, 201);
    assert.equal(r.body.type, 'url');
    assert.equal(r.body.title, 'http://169.254.169.254/latest/meta-data');
    assert.equal(r.body.metadata.description, undefined, 'nothing was fetched');
  });

  it('CAP-02 rejects non-http URLs', async () => {
    assert.equal((await A.post('/api/notes/capture-url', { url: 'file:///etc/passwd' })).status, 400);
    assert.equal((await A.post('/api/notes/capture-url', { url: 'not a url' })).status, 400);
  });
});
