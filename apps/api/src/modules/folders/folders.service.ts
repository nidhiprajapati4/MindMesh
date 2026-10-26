import { Types } from 'mongoose';
import { HttpError } from '../../middleware/errors';
import { Folder } from '../../models/Folder';
import { Note } from '../../models/Note';

type FolderInput = { name?: string; color?: string | null };

const isDuplicateKey = (err: unknown) => (err as { code?: number })?.code === 11000;

export async function listFolders(userId: string) {
  const [folders, counts] = await Promise.all([
    Folder.find({ userId }).collation({ locale: 'en', strength: 2 }).sort({ name: 1 }).lean(),
    Note.aggregate<{ _id: Types.ObjectId | null; count: number }>([
      { $match: { userId: new Types.ObjectId(userId), deletedAt: null, archived: false } },
      { $group: { _id: '$folderId', count: { $sum: 1 } } },
    ]),
  ]);
  const byId = new Map(counts.map((c) => [String(c._id), c.count]));
  return {
    folders: folders.map((f) => ({ ...f, noteCount: byId.get(String(f._id)) ?? 0 })),
    unfiledCount: byId.get('null') ?? 0,
  };
}

/** Throws 404 unless the folder exists and belongs to the user. */
export async function assertFolderOwned(userId: string, folderId: string) {
  const exists = await Folder.exists({ _id: folderId, userId });
  if (!exists) throw new HttpError(404, 'Folder not found');
}

export async function createFolder(userId: string, input: Required<FolderInput>) {
  try {
    return await Folder.create({ ...input, userId });
  } catch (err) {
    if (isDuplicateKey(err)) throw new HttpError(409, 'A folder with that name already exists');
    throw err;
  }
}

export async function updateFolder(userId: string, id: string, input: FolderInput) {
  try {
    const folder = await Folder.findOneAndUpdate({ _id: id, userId }, { $set: input }, { new: true, runValidators: true }).lean();
    if (!folder) throw new HttpError(404, 'Folder not found');
    return folder;
  } catch (err) {
    if (isDuplicateKey(err)) throw new HttpError(409, 'A folder with that name already exists');
    throw err;
  }
}

/** Deletes the folder; its notes are kept and become unfiled. */
export async function deleteFolder(userId: string, id: string) {
  const result = await Folder.deleteOne({ _id: id, userId });
  if (!result.deletedCount) throw new HttpError(404, 'Folder not found');
  await Note.updateMany({ userId, folderId: id }, { $set: { folderId: null } });
}
