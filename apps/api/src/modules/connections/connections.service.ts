import { HttpError } from '../../middleware/errors';
import { Note } from '../../models/Note';
import { BRIEF_FIELDS, brief, type Brief } from '../notes/note-brief';

export const MAX_BACKLINKS = 100;

type Outgoing = { title: string; note: Brief | null; state: 'ok' | 'missing' | 'trashed' };

/**
 * A note's links: the notes it links to ([[Title]] in its text) and the notes linking to it.
 * Trashed notes never appear as backlinks; a link to a trashed note says so.
 */
export async function noteLinks(userId: string, id: string) {
  const note = await Note.findOne({ _id: id, userId, deletedAt: null }, { outLinks: 1 }).lean();
  if (!note) throw new HttpError(404, 'Note not found');

  const targetIds = note.outLinks.map((l) => l.noteId).filter((x) => x !== null);
  const targets = await Note.find({ userId, _id: { $in: targetIds } }, { ...BRIEF_FIELDS, deletedAt: 1 }).lean();
  const byId = new Map(targets.map((t) => [String(t._id), t]));
  const outgoing: Outgoing[] = note.outLinks.map((l) => {
    const t = l.noteId ? byId.get(String(l.noteId)) : undefined;
    if (!t) return { title: l.title, note: null, state: 'missing' };
    if (t.deletedAt) return { title: l.title, note: null, state: 'trashed' };
    return { title: l.title, note: brief(t), state: 'ok' };
  });

  const backlinks = await Note.find({ userId, deletedAt: null, _id: { $ne: note._id }, 'outLinks.noteId': note._id }, BRIEF_FIELDS)
    .sort({ updatedAt: -1 })
    .limit(MAX_BACKLINKS)
    .lean();
  return { outgoing, backlinks: backlinks.map(brief) };
}
