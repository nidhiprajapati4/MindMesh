/**
 * Fills a MindMesh account with a demo library (about 65 notes) so every feature has something
 * to show: folders and tags, search by meaning, Ask, tag and folder suggestions, duplicates, key
 * points, [[links]], the graph and topics.
 *
 *   npm run demo:seed -w apps/api -- --email you@example.com [--force]
 *
 * Sign in to the app once with that email first (that creates the account). Uses the database in
 * apps/api/.env. Refuses to touch an account that already has notes unless --force is given.
 * The worker (separate, or RUN_WORKER=inline in the API) then prepares the notes for search.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import mongoose from 'mongoose';
import { connectDb } from '../src/config/db';
import { Note } from '../src/models/Note';
import { User } from '../src/models/User';
import { createFolder } from '../src/modules/folders/folders.service';
import { createNote } from '../src/modules/notes/notes.service';

type Item = { title: string; content: string; tags: string[]; type?: string };
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(__dirname, '..', 'eval', file), 'utf8'));
const dataset = read<(Item & { id: string })[]>('search/dataset.json');
const extra = read<{
  folders: Record<string, string[]>;
  denseTopics: { folder: string; tags: string[]; notes: Item[] }[];
  nearDuplicates: { of: string; title: string; content: string }[];
  longNotes: { title: string; content: string }[];
}>('organize/extra.json');

const LINKED: Item[] = [
  {
    title: 'Weekend plan',
    content: 'Saturday: bake using [[Sourdough hydration]] and an overnight proof, then an [[Easy run pace]] loop.\nSunday: make the [[Picnic menu]] and pack for the hike.',
    tags: ['plans'],
  },
  {
    title: 'Platform runbook',
    content: 'Before a release, check [[Pod resource limits]] and plan the [[Rolling deployments]]. If pods restart, start with [[Debugging CrashLoopBackOff]] and the [[Kubernetes probes]] note.',
    tags: ['kubernetes'],
  },
];

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : '';
}

async function main() {
  const email = arg('email');
  if (!email) throw new Error('Usage: npm run demo:seed -w apps/api -- --email you@example.com [--force]');
  await connectDb();

  const exact = new RegExp(`^${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
  const users = await User.find({ email: exact }).lean();
  if (!users.length) throw new Error(`No account for ${email}. Sign in to the app once with it, then run this again.`);
  if (users.length > 1) throw new Error(`Several accounts use ${email}; this script needs exactly one.`);
  const userId = String(users[0]._id);

  const existing = await Note.countDocuments({ userId, deletedAt: null });
  if (existing && arg('force') === undefined) throw new Error(`${email} already has ${existing} notes. Add --force to add the demo library anyway.`);

  const folderIds = new Map<string, string>();
  const folder = async (name: string) => {
    if (!folderIds.has(name)) {
      const f = await createFolder(userId, { name, color: null }).catch(async () => (await import('../src/models/Folder')).Folder.findOne({ userId, name }).lean());
      folderIds.set(name, String(f!._id));
    }
    return folderIds.get(name)!;
  };
  const broad = (tags: string[]) => Object.entries(extra.folders).find(([, ts]) => tags.some((t) => ts.includes(t)))?.[0] ?? null;
  let count = 0;
  const add = async (n: Item, folderName: string | null, extraFields: Record<string, unknown> = {}) => {
    await createNote(userId, {
      type: (n.type ?? 'note') as never,
      title: n.title,
      content: n.content,
      tags: n.tags,
      folderId: folderName ? await folder(folderName) : null,
      sourceUrl: null,
      metadata: {},
      pinned: false,
      archived: false,
      ...extraFields,
    });
    count++;
  };

  for (const it of dataset) await add(it, broad(it.tags));
  for (const t of extra.denseTopics) for (const n of t.notes) await add({ ...n, tags: t.tags }, t.folder);
  for (const l of extra.longNotes) await add({ title: l.title, content: l.content, tags: ['reading'], type: 'document' }, 'Work');
  // Reworded copies, so "Possible duplicates" has something to find.
  for (const d of extra.nearDuplicates.slice(0, 2)) await add({ title: d.title, content: d.content, tags: [] }, null);
  // Links last, so they find the notes they point to ("Picnic menu" stays a link to a note not yet written).
  for (const n of LINKED) await add(n, null);
  await add(
    { title: 'Sourdough (Wikipedia)', content: 'Background reading on how wild yeast and lactobacilli make bread rise.', tags: ['baking'], type: 'url' },
    'Kitchen',
    { sourceUrl: 'https://en.wikipedia.org/wiki/Sourdough', metadata: { siteName: 'Wikipedia', description: 'Sourdough is bread made by the fermentation of dough using wild lactobacillaceae and yeast.' } }
  );

  console.log(`Added ${count} notes in ${folderIds.size} folders for ${email}.`);
  console.log('They are prepared for search in the background: keep the worker running (or RUN_WORKER=inline) for a minute or two.');
}

main()
  .catch((e) => {
    console.error((e as Error).message);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
