import { Types } from 'mongoose';
import { Note, titleKey } from '../../models/Note';
import { queueIfChanged } from '../ai-processing/jobs';

type Id = Types.ObjectId | string;
export type OutLink = { key: string; title: string; noteId?: Types.ObjectId | null };

export const MAX_LINKS = 100;
const LINK = /\[\[([^[\]\n]{1,200})\]\]/g;
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The [[Title]] links written in a note, deduplicated by title (case and spacing ignored).
 * Code blocks, inline code and snippets are skipped: brackets there are code, not links.
 */
export function parseLinks(content: string, type?: string): { key: string; title: string }[] {
  if (type === 'snippet' || !content.includes('[[')) return [];
  const text = content.replace(/```[\s\S]*?(```|$)/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const found = new Map<string, string>();
  for (const m of text.matchAll(LINK)) {
    const title = m[1].replace(/\s+/g, ' ').trim();
    const key = titleKey(title);
    if (key && !found.has(key)) found.set(key, title);
    if (found.size >= MAX_LINKS) break;
  }
  return [...found].map(([key, title]) => ({ key, title }));
}

/** Matches [[title]] in text for a given title key, however its case and spacing were written. */
const linkPattern = (key: string) => new RegExp(`\\[\\[\\s*${key.split(' ').map(escapeRegex).join('\\s+')}\\s*\\]\\]`, 'giu');

/** The note each title key links to: the user's active note with that title, most recently updated first. */
async function resolveKeys(userId: Id, keys: string[], selfId: Id) {
  const byKey = new Map<string, Types.ObjectId>();
  if (!keys.length) return byKey;
  const notes = await Note.find({ userId, deletedAt: null, titleKey: { $in: keys }, _id: { $ne: selfId } }, { titleKey: 1 })
    .sort({ updatedAt: -1 })
    .lean();
  for (const n of notes) if (!byKey.has(n.titleKey)) byKey.set(n.titleKey, n._id);
  return byKey;
}

/** Points links with this title that lead nowhere (no note yet, or one in the trash) at `noteId`. */
async function resolveDangling(userId: Id, key: string, noteId: Id) {
  const trashed = await Note.find({ userId, titleKey: key, deletedAt: { $ne: null } }).distinct('_id');
  await Note.updateMany(
    { userId, _id: { $ne: noteId }, outLinks: { $elemMatch: { key, noteId: { $in: [null, ...trashed] } } } },
    { $set: { 'outLinks.$[l].noteId': noteId } },
    { arrayFilters: [{ 'l.key': key, 'l.noteId': { $in: [null, ...trashed] } }], timestamps: false }
  );
}

/**
 * A note was renamed: rewrite [[Old title]] to [[New title]] in the notes linking to it, so the
 * links keep working and read correctly. Their "updated" time is left alone; they're re-embedded.
 */
async function renameLinksTo(userId: Id, noteId: Id, newTitle: string) {
  const newKey = titleKey(newTitle);
  const linking = await Note.find({ userId, _id: { $ne: noteId }, 'outLinks.noteId': noteId }).lean();
  for (const n of linking) {
    let content = n.content;
    const outLinks: OutLink[] = [];
    for (const l of n.outLinks) {
      if (String(l.noteId) !== String(noteId)) outLinks.push(l);
      else if (!newKey) outLinks.push({ ...l, noteId: null }); // renamed to nothing: the link text can't follow
      else {
        content = content.replace(linkPattern(l.key), () => `[[${newTitle}]]`);
        outLinks.push({ key: newKey, title: newTitle, noteId: l.noteId });
      }
    }
    const unique = outLinks.filter((l, i) => outLinks.findIndex((o) => o.key === l.key) === i);
    const updated = await Note.findOneAndUpdate({ _id: n._id }, { $set: { content, outLinks: unique } }, { new: true, timestamps: false }).lean();
    if (updated) await queueIfChanged(updated, false, true);
  }
}

/**
 * Keeps a note's links current after it was saved. `previousTitleKey` is the title key before this
 * save; leave it out when the note has just appeared (created, uploaded or restored), so links
 * that were waiting for its title now lead to it.
 */
export async function syncLinks(
  note: { _id: Id; userId: Id; type?: string; title: string; content?: string | null },
  previousTitleKey?: string
): Promise<OutLink[]> {
  const parsed = parseLinks(note.content ?? '', note.type);
  const resolved = await resolveKeys(note.userId, parsed.map((p) => p.key), note._id);
  const outLinks = parsed.map((p) => ({ ...p, noteId: resolved.get(p.key) ?? null }));
  await Note.updateOne({ _id: note._id }, { $set: { outLinks } }, { timestamps: false });

  const key = titleKey(note.title);
  if (previousTitleKey !== undefined && previousTitleKey !== key) await renameLinksTo(note.userId, note._id, note.title);
  if (key && previousTitleKey !== key) await resolveDangling(note.userId, key, note._id);
  return outLinks;
}

/**
 * Notes were deleted forever: links to them lead nowhere now, unless another note has the same
 * title, in which case they lead there.
 */
export async function unlinkDeleted(userId: Id, deleted: { _id: Id; titleKey?: string | null }[]) {
  if (!deleted.length) return;
  const ids = deleted.map((d) => new Types.ObjectId(String(d._id)));
  await Note.updateMany(
    { userId, 'outLinks.noteId': { $in: ids } },
    { $set: { 'outLinks.$[l].noteId': null } },
    { arrayFilters: [{ 'l.noteId': { $in: ids } }], timestamps: false }
  );
  for (const key of new Set(deleted.map((d) => d.titleKey).filter((k): k is string => !!k))) {
    const other = await Note.findOne({ userId, titleKey: key, deletedAt: null }, { _id: 1 }).sort({ updatedAt: -1 }).lean();
    if (other) await resolveDangling(userId, key, other._id);
  }
}

/** How many of the user's notes (not trashed) link to each of these notes. */
export async function backlinkCounts(userId: Id, noteIds: Id[]) {
  const ids = noteIds.map((id) => new Types.ObjectId(String(id)));
  const rows = await Note.aggregate<{ _id: Types.ObjectId; n: number }>([
    { $match: { userId: new Types.ObjectId(String(userId)), deletedAt: null, 'outLinks.noteId': { $in: ids } } },
    { $unwind: '$outLinks' },
    { $match: { 'outLinks.noteId': { $in: ids }, $expr: { $ne: ['$outLinks.noteId', '$_id'] } } },
    { $group: { _id: '$outLinks.noteId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [String(r._id), r.n]));
}

/** Gives notes saved before Phase 6 their title key and links. Safe to run repeatedly. */
export async function backfillLinks() {
  const ops = [];
  for await (const n of Note.find({ titleKey: { $exists: false } }, { title: 1 }).lean().cursor()) {
    ops.push({ updateOne: { filter: { _id: n._id }, update: { $set: { titleKey: titleKey(n.title ?? '') } } } });
  }
  for (let i = 0; i < ops.length; i += 500) await Note.bulkWrite(ops.slice(i, i + 500), { ordered: false });

  await Note.updateMany({ outLinks: { $exists: false }, content: { $not: /\[\[/ } }, { $set: { outLinks: [] } }, { timestamps: false });
  let linked = 0;
  for await (const n of Note.find({ outLinks: { $exists: false } }, { userId: 1, type: 1, title: 1, content: 1, titleKey: 1 }).lean().cursor()) {
    await syncLinks(n, n.titleKey ?? titleKey(n.title));
    linked++;
  }
  return { keyed: ops.length, linked };
}
