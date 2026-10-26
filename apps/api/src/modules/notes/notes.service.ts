import type { FilterQuery, SortOrder } from 'mongoose';
import { HttpError } from '../../middleware/errors';
import { Note, type INote } from '../../models/Note';
import { assertFolderOwned } from '../folders/folders.service';
import { fetchUrlMetadata } from './url-metadata';
import type { CreateNoteInput, ListQuery, UpdateNoteInput } from './notes.schema';

const notFound = () => new HttpError(404, 'Note not found');
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function baseFilter(userId: string, query: ListQuery): FilterQuery<INote> {
  const view = query.archived ? 'archived' : query.view;
  const filter: FilterQuery<INote> = { userId };
  if (view === 'trash') filter.deletedAt = { $ne: null };
  else Object.assign(filter, { deletedAt: null, archived: view === 'archived' });

  if (query.tag) filter.tags = query.tag;
  if (query.type) filter.type = query.type;
  if (query.folder) filter.folderId = query.folder === 'none' ? null : query.folder;
  if (query.pinned !== undefined) filter.pinned = query.pinned;
  if (query.from || query.to) {
    filter.updatedAt = {};
    if (query.from) filter.updatedAt.$gte = query.from;
    if (query.to) filter.updatedAt.$lte = query.to;
  }
  return filter;
}

function sortFor(query: ListQuery, textSearch: boolean): Record<string, SortOrder | { $meta: 'textScore' }> {
  if (query.view === 'trash') return { deletedAt: -1 };
  switch (query.sort) {
    case 'relevance':
      return textSearch ? { score: { $meta: 'textScore' } } : { pinned: -1, updatedAt: -1 };
    case 'created':
      return { pinned: -1, createdAt: -1 };
    case 'title':
      return { pinned: -1, title: 1 };
    default:
      return { pinned: -1, updatedAt: -1 };
  }
}

async function runList(filter: FilterQuery<INote>, query: ListQuery, textSearch: boolean) {
  const find = Note.find(filter, textSearch ? { score: { $meta: 'textScore' } } : {})
    .sort(sortFor(query, textSearch))
    .skip((query.page - 1) * query.limit)
    .limit(query.limit)
    .lean();
  // Case-insensitive title ordering; $text queries only support the simple collation.
  if (query.sort === 'title' && !textSearch) find.collation({ locale: 'en', strength: 2 });
  const [items, total] = await Promise.all([find, Note.countDocuments(filter)]);
  return { items, total };
}

/**
 * Keyword search: MongoDB full-text search (stemmed, relevance-ranked) first. If that finds
 * nothing, fall back to a case-insensitive substring match so partial words ("retr") still hit.
 */
export async function listNotes(userId: string, query: ListQuery) {
  const filter = baseFilter(userId, query);
  let matchMode: 'all' | 'text' | 'partial' = 'all';
  let result;

  if (query.q) {
    matchMode = 'text';
    result = await runList({ ...filter, $text: { $search: query.q } }, query, true);
    if (result.total === 0) {
      matchMode = 'partial';
      const re = new RegExp(escapeRegex(query.q), 'i');
      result = await runList({ ...filter, $or: [{ title: re }, { content: re }, { tags: re }, { sourceUrl: re }] }, query, false);
    }
  } else {
    result = await runList(filter, query, false);
  }

  return { ...result, page: query.page, limit: query.limit, matchMode };
}

export async function listTags(userId: string) {
  const tags = await Note.distinct('tags', { userId, deletedAt: null, archived: false });
  return tags.sort();
}

export async function createNote(userId: string, input: CreateNoteInput) {
  if (input.folderId) await assertFolderOwned(userId, input.folderId);
  return Note.create({ ...input, userId });
}

export async function getNote(userId: string, id: string) {
  const note = await Note.findOne({ _id: id, userId }).lean();
  if (!note) throw notFound();
  return note;
}

export async function updateNote(userId: string, id: string, input: UpdateNoteInput) {
  if (input.folderId) await assertFolderOwned(userId, input.folderId);
  const note = await Note.findOneAndUpdate({ _id: id, userId, deletedAt: null }, { $set: input }, { new: true, runValidators: true }).lean();
  if (!note) throw notFound();
  return note;
}

export async function trashNote(userId: string, id: string) {
  const note = await Note.findOneAndUpdate(
    { _id: id, userId, deletedAt: null },
    { $set: { deletedAt: new Date(), pinned: false } },
    { new: true }
  ).lean();
  if (!note) throw notFound();
  return note;
}

export async function restoreNote(userId: string, id: string) {
  const note = await Note.findOneAndUpdate({ _id: id, userId, deletedAt: { $ne: null } }, { $set: { deletedAt: null } }, { new: true }).lean();
  if (!note) throw notFound();
  return note;
}

/** Permanent delete is only allowed for items already in the trash. */
export async function destroyNote(userId: string, id: string) {
  const result = await Note.deleteOne({ _id: id, userId, deletedAt: { $ne: null } });
  if (!result.deletedCount) throw notFound();
}

export async function emptyTrash(userId: string) {
  const result = await Note.deleteMany({ userId, deletedAt: { $ne: null } });
  return { deleted: result.deletedCount };
}

/**
 * Saves a URL as an item. Page metadata is best-effort: if the page can't be fetched
 * the item is still saved with the URL as its title, so capture never blocks on the network.
 */
export async function captureUrl(userId: string, input: { url: string; folderId: string | null; tags: string[] }) {
  if (input.folderId) await assertFolderOwned(userId, input.folderId);
  const meta = await fetchUrlMetadata(input.url).catch(() => null);
  return Note.create({
    userId,
    type: 'url',
    title: (meta?.title || input.url).slice(0, 200),
    content: '',
    sourceUrl: meta?.finalUrl ?? input.url,
    tags: input.tags,
    folderId: input.folderId,
    metadata: {
      siteName: meta?.siteName,
      description: meta?.description,
      author: meta?.author,
    },
  });
}
