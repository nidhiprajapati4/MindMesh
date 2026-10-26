import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createNoteSchema, listQuerySchema, updateNoteSchema } from './notes.schema';

describe('createNoteSchema', () => {
  it('applies Phase 2 defaults', () => {
    const note = createNoteSchema.parse({ title: '  Hi  ' });
    assert.equal(note.title, 'Hi');
    assert.equal(note.type, 'note');
    assert.equal(note.folderId, null);
    assert.deepEqual(note.metadata, {});
  });

  it('normalises and deduplicates tags', () => {
    assert.deepEqual(createNoteSchema.parse({ tags: ['JS', 'js', ' Node '] }).tags, ['js', 'node']);
  });

  it('rejects client-supplied ownership and unknown fields', () => {
    assert.throws(() => createNoteSchema.parse({ userId: 'abc' }));
    assert.throws(() => createNoteSchema.parse({ metadata: { evil: 'x' } }));
  });

  it('rejects non-http source URLs and bad folder ids', () => {
    assert.throws(() => createNoteSchema.parse({ sourceUrl: 'javascript:alert(1)' }));
    assert.throws(() => createNoteSchema.parse({ folderId: 'not-an-id' }));
  });
});

describe('updateNoteSchema', () => {
  it('allows clearing folder and source URL', () => {
    assert.deepEqual(updateNoteSchema.parse({ folderId: null, sourceUrl: null }), { folderId: null, sourceUrl: null });
  });
});

describe('listQuerySchema', () => {
  it('parses filters from query strings', () => {
    const q = listQuerySchema.parse({ type: 'snippet', folder: 'none', pinned: 'true', view: 'trash', limit: '5' });
    assert.equal(q.type, 'snippet');
    assert.equal(q.folder, 'none');
    assert.equal(q.pinned, true);
    assert.equal(q.view, 'trash');
    assert.equal(q.limit, 5);
    assert.equal(q.sort, 'updated');
  });

  it('caps the page size', () => {
    assert.throws(() => listQuerySchema.parse({ limit: '500' }));
  });
});
