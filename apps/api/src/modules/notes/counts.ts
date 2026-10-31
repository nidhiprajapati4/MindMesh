import { Types } from 'mongoose';
import { Conversation } from '../../models/Conversation';
import { Note, NOTE_TYPES } from '../../models/Note';
import { SavedAnswer } from '../../models/SavedAnswer';
import { duplicatePairs } from '../organize/organize.service';

/**
 * The numbers shown in brackets in the sidebar. `all`, `types`, `tags` and `favourites` cover active
 * items (not archived, not in trash), like the lists they sit next to. Duplicates are only worked
 * out when asked for, because that compares every pair of items.
 */
export async function noteCounts(userId: string, withDuplicates: boolean) {
  const owner = new Types.ObjectId(userId);
  const active = { userId: owner, deletedAt: null, archived: false };
  const [archived, trash, favourites, byType, byTag, conversations, saved] = await Promise.all([
    Note.countDocuments({ userId: owner, deletedAt: null, archived: true }),
    Note.countDocuments({ userId: owner, deletedAt: { $ne: null } }),
    Note.countDocuments({ ...active, favourite: true }),
    Note.aggregate<{ _id: string; count: number }>([{ $match: active }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
    Note.aggregate<{ _id: string; count: number }>([{ $match: active }, { $unwind: '$tags' }, { $group: { _id: '$tags', count: { $sum: 1 } } }]),
    Conversation.countDocuments({ userId: owner }),
    SavedAnswer.countDocuments({ userId: owner }),
  ]);

  const types = Object.fromEntries(NOTE_TYPES.map((t) => [t, 0])) as Record<(typeof NOTE_TYPES)[number], number>;
  for (const row of byType) if (row._id in types) types[row._id as keyof typeof types] = row.count;

  return {
    all: Object.values(types).reduce((a, b) => a + b, 0),
    archived,
    trash,
    favourites,
    types,
    tags: Object.fromEntries(byTag.map((t) => [t._id, t.count])),
    conversations,
    saved,
    ...(withDuplicates ? { duplicates: (await duplicatePairs(userId).catch(() => ({ pairs: [] }))).pairs.length } : {}),
  };
}
