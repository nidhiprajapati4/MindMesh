/**
 * Loads docs/sample-data/test-user.json into a MindMesh account: folders, notes (with their tags,
 * links, uploaded-file details and states) and Ask conversations. Search, the graph, topics and
 * duplicates are not stored; they appear once the worker has prepared the notes.
 *
 *   npm run import:sample -w apps/api -- --email test.user@example.com [--file path.json] [--force] [--reset] [--skip-language]
 *
 * Sign in to the app once with that email first (that creates the account). Uses the database in
 * apps/api/.env. Refuses to touch an account that already has notes unless --force is given.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db';
import { Conversation } from '../src/models/Conversation';
import { Folder } from '../src/models/Folder';
import { Note } from '../src/models/Note';
import { ProcessingJob } from '../src/models/ProcessingJob';
import { User } from '../src/models/User';
import { createFolder } from '../src/modules/folders/folders.service';
import { createNote } from '../src/modules/notes/notes.service';

type SampleNote = {
  id: string;
  type: string;
  title: string;
  content: string;
  tags: string[];
  folderId: string | null;
  sourceUrl: string | null;
  metadata: Record<string, unknown>;
  pinned: boolean;
  archived: boolean;
  deletedAt: string | null;
  keyPoints: string[];
  createdAt: string;
  updatedAt: string;
};
type SampleTurn = { sources: { noteId: string; title: string }[]; [k: string]: unknown };
type Sample = {
  folders: { id: string; name: string; color: string | null }[];
  notes: SampleNote[];
  conversations: { title: string; turns: SampleTurn[]; createdAt: string; updatedAt: string }[];
};

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : '';
}

async function main() {
  const email = arg('email');
  if (!email) throw new Error('Usage: npm run import:sample -w apps/api -- --email you@example.com [--file path.json] [--force]');
  const file = arg('file') || path.join(__dirname, '..', '..', '..', 'docs', 'sample-data', 'test-user.json');
  const data = JSON.parse(readFileSync(file, 'utf8')) as Sample;
  await connectDb();

  const exact = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const users = await User.find({ email: exact }).lean();
  if (!users.length) throw new Error(`No account for ${email}. Sign in to the app once with it, then run this again.`);
  if (users.length > 1) throw new Error(`Several accounts use ${email}; this script needs exactly one.`);
  const userId = String(users[0]._id);

  // --reset first deletes everything this account has (notes, jobs, conversations); for a test account only.
  if (arg('reset') !== undefined) {
    const mine = await Note.find({ userId }, { _id: 1 }).lean();
    await ProcessingJob.deleteMany({ noteId: { $in: mine.map((n) => n._id) } });
    await Note.deleteMany({ userId });
    await Conversation.deleteMany({ userId });
    console.log(`Removed ${mine.length} existing notes from ${email}.`);
  }
  const existing = await Note.countDocuments({ userId, deletedAt: null });
  if (existing && arg('force') === undefined) throw new Error(`${email} already has ${existing} notes. Add --force to import the sample data anyway.`);

  const folderIds = new Map<string, string>();
  for (const f of data.folders) {
    const made = await createFolder(userId, { name: f.name, color: f.color }).catch(() => Folder.findOne({ userId, name: f.name }).lean());
    folderIds.set(f.id, String(made!._id));
  }

  // Notes are created through the service, so links and processing jobs are set up as in the app.
  // A [[link]] to a note created later is connected when that note arrives.
  // --skip-language drops each note's metadata.language: a database whose text index predates the
  // textSearchLanguage override rejects values like "ts".
  const skipLanguage = arg('skip-language') !== undefined;
  const noteIds = new Map<string, string>();
  for (const n of data.notes) {
    const made = await createNote(userId, {
      type: n.type as never,
      title: n.title,
      content: n.content,
      tags: n.tags,
      folderId: n.folderId ? folderIds.get(n.folderId)! : null,
      sourceUrl: n.sourceUrl,
      metadata: (skipLanguage ? { ...n.metadata, language: undefined } : n.metadata) as never,
      pinned: n.pinned,
      archived: n.archived,
    });
    noteIds.set(n.id, String(made._id));
    // Fields the API does not let clients set: key points, trash state and the original dates.
    await Note.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(String(made._id)) },
      { $set: { keyPoints: n.keyPoints, deletedAt: n.deletedAt ? new Date(n.deletedAt) : null, createdAt: new Date(n.createdAt), updatedAt: new Date(n.updatedAt) } }
    );
    if (n.deletedAt) await ProcessingJob.deleteMany({ noteId: made._id });
  }

  let conversations = 0;
  for (const c of data.conversations) {
    await Conversation.collection.insertOne({
      title: c.title,
      userId: new mongoose.Types.ObjectId(userId),
      turns: c.turns.map((t) => ({
        ...t,
        createdAt: new Date(t.createdAt as string),
        sources: t.sources.map((s) => ({ noteId: new mongoose.Types.ObjectId(noteIds.get(s.noteId)!), title: s.title })),
      })),
      createdAt: new Date(c.createdAt),
      updatedAt: new Date(c.updatedAt),
    });
    conversations++;
  }

  console.log(`Imported ${noteIds.size} notes, ${folderIds.size} folders and ${conversations} conversations for ${email}.`);
  console.log('Notes are prepared for search in the background: keep the worker running (or RUN_WORKER=inline) for a minute or two.');
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
