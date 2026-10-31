import { Types, type FilterQuery } from 'mongoose';
import { Folder } from '../../models/Folder';
import { Note, type INote, type NoteType } from '../../models/Note';
import { BRIEF_FIELDS, brief } from '../notes/note-brief';

/**
 * Questions about the library itself ("how many documents do I have?", "list my latest 5 notes")
 * are answered from the database, not by matching sentences inside notes. Detection is plain
 * keyword rules, so casual wording and small typos still work and nothing is sent to a model.
 */

export type LibraryIntent = {
  action: 'count' | 'list';
  /** Only the specific types named ("documents", "links"…); empty means every type. */
  types: NoteType[];
  /** "notes" / "items" on their own mean everything the user has saved. */
  generic: boolean;
  view: 'active' | 'archived' | 'trash';
  pinned: boolean;
  favourite: boolean;
  tag: string | null;
  folder: { id: string; name: string } | 'none' | null;
  since: { from: Date; to: Date | null; label: string } | null;
  dateField: 'createdAt' | 'updatedAt';
  limit: number;
  /** Asked how many tags / folders there are, rather than how many items. */
  about: 'tags' | 'folders' | null;
  recent: boolean;
};

export type LibraryAnswer = {
  segments: { text: string; citations: { source: number; quote: string }[] }[];
  sources: { noteId: string; title: string; type: string }[];
};

const TYPE_WORDS: [RegExp, NoteType][] = [
  [/\bsnippets?\b|\bcode\b/, 'snippet'],
  [/\blinks?\b|\burls?\b|\bbookmarks?\b|\bwebsites?\b|\bweb pages?\b/, 'url'],
  [/\bideas?\b/, 'idea'],
  [/\bdocuments?\b|\bdocs?\b|\bfiles?\b|\bpdfs?\b|\buploads?\b|\buploaded\b/, 'document'],
];
const GENERIC_NOUN = /\b(notes?|items?|things|entries|stuff)\b/;
const ANY_NOUN = /\b(notes?|items?|things|entries|stuff|documents?|docs?|files?|pdfs?|links?|urls?|bookmarks?|snippets?|ideas?|uploads?|folders?|tags?)\b/;
const COUNT_WORDS = /\b(how many|how much|count|number of|total)\b|\bno\.? of\b/;
const LIST_WORDS = /\b(list|show|display|give me|what are|which)\b/;
const RECENT_WORDS = /\b(latest|newest|most recent|recent|recently|last)\b/;
// Asking what the notes SAY, not about the library: leave these to normal note search.
const ABOUT_CONTENT = /\b(about|regarding|related to|relating to|mentions?|mentioning|containing|contain|that (say|talk|discuss|cover)|on the topic)\b/;

const MONTH_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function timeRange(q: string, now: Date): LibraryIntent['since'] {
  const today = startOfDay(now);
  const days = /\b(?:last|past|previous)\s+(\d{1,3})\s+days?\b/.exec(q);
  if (days) return { from: new Date(today.getTime() - (Number(days[1]) - 1) * MONTH_MS), to: null, label: `in the last ${days[1]} days` };
  if (/\btoday\b/.test(q)) return { from: today, to: null, label: 'today' };
  if (/\byesterday\b/.test(q)) return { from: new Date(today.getTime() - MONTH_MS), to: today, label: 'yesterday' };
  if (/\blast week\b|\bpast week\b/.test(q)) {
    const monday = new Date(today.getTime() - ((today.getDay() + 6) % 7) * MONTH_MS);
    return { from: new Date(monday.getTime() - 7 * MONTH_MS), to: monday, label: 'last week' };
  }
  if (/\bthis week\b/.test(q)) return { from: new Date(today.getTime() - ((today.getDay() + 6) % 7) * MONTH_MS), to: null, label: 'this week' };
  if (/\blast month\b|\bpast month\b/.test(q)) return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1), label: 'last month' };
  if (/\bthis month\b/.test(q)) return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: null, label: 'this month' };
  if (/\bthis year\b/.test(q)) return { from: new Date(now.getFullYear(), 0, 1), to: null, label: 'this year' };
  return null;
}

/** Works out whether `question` is about the library. Returns null for questions about note content. */
export function parseLibraryQuestion(question: string, folderNames: { id: string; name: string }[] = [], now = new Date()): LibraryIntent | null {
  const q = question.toLowerCase().replace(/[’‘]/g, "'").replace(/[?!.,;]+(\s|$)/g, ' ').replace(/\s+/g, ' ').trim();
  if (!q || ABOUT_CONTENT.test(q)) return null;

  const lastAdded = /\b(what|which)\b.*\b(did i|have i|was the|is the)\b.*\b(add|added|save|saved|create|created|write|wrote|written|last|latest)\b/.test(q) && !ANY_NOUN.test(q);
  const hasNoun = ANY_NOUN.test(q);
  const asksCount = COUNT_WORDS.test(q);
  const asksList = LIST_WORDS.test(q) || RECENT_WORDS.test(q);
  if (!lastAdded && !(hasNoun && (asksCount || asksList))) return null;

  // A short question like "how many notes are there" is about the user's library too.
  const mine = q.split(' ').length <= 8 || /\b(i|i've|ive|my|me|mine|we|have|had|own|added|saved|created|stored|wrote|written|uploaded|in total|so far|till now|until now|up to now|all)\b/.test(q);
  const types = TYPE_WORDS.filter(([re]) => re.test(q)).map(([, t]) => t);
  const generic = GENERIC_NOUN.test(q) || (!types.length && !/\b(folders?|tags?)\b/.test(q));

  const tagName =
    /#([a-z0-9][\w-]*)/.exec(q)?.[1] ??
    /\btag(?:ged)?\b(?:\s+(?:with|as|is|named|called))?\s*:?\s*#?([a-z0-9][\w-]*)/.exec(q)?.[1] ??
    null;
  const tag = tagName && !['s', 'with', 'are', 'do', 'did', 'have', 'i', 'my', 'there'].includes(tagName) ? tagName : null;

  let folder: LibraryIntent['folder'] = /\bunfiled\b|\bno folder\b|\bwithout (a )?folder\b/.test(q) ? 'none' : null;
  if (!folder && /\bfolders?\b|\bin\b|\binside\b|\bunder\b/.test(q)) {
    const hit = [...folderNames]
      .sort((a, b) => b.name.length - a.name.length)
      .find((f) => new RegExp(`(^|[^\\w])${f.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w])`).test(q));
    if (hit) folder = hit;
  }

  const view: LibraryIntent['view'] = /\barchived?\b/.test(q) ? 'archived' : /\b(trash|trashed|deleted|bin|recycle)\b/.test(q) ? 'trash' : 'active';
  const favourite = /\bfavou?rites?\b|\bstarred\b|\bstars?\b/.test(q);
  const pinned = /\bpinned\b/.test(q);
  const since = timeRange(q, now);
  const dateField = /\b(edited|updated|modified|changed)\b/.test(q) ? 'updatedAt' : 'createdAt';
  const recent = RECENT_WORDS.test(q) || lastAdded;

  const n = /\b(?:latest|newest|recent|last|top|first)\s+(\d{1,2})\b/.exec(q)?.[1] ?? /\b(\d{1,2})\s+(?:latest|newest|recent|last)\b/.exec(q)?.[1];
  const singular = lastAdded || /\b(last|latest|newest|most recent)\s+(note|item|document|doc|file|link|snippet|idea)\b(?!s)/.test(q) || /\bwhat did i add last\b/.test(q);
  const limit = Math.min(10, Math.max(1, n ? Number(n) : singular ? 1 : 5));

  // "How many tags / folders do I have": about the organisation, not the items.
  const about = !tag && !folder && /\bfolders\b/.test(q) && !GENERIC_NOUN.test(q.replace(/folders?/g, '')) ? 'folders' : !tag && !folder && /\btags\b/.test(q) && asksCount ? 'tags' : null;

  const action: LibraryIntent['action'] = asksCount ? 'count' : 'list';
  // Without any sign the question is about the user's own library, "how many pods" style questions
  // stay with note search.
  const filtered = !!(types.length || tag || folder || view !== 'active' || favourite || pinned || since || about);
  if (!mine && !filtered && !lastAdded) return null;

  return { action, types, generic: generic && !types.length, view, pinned, favourite, tag, folder, since, dateField, limit, about, recent };
}

const LABEL: Record<NoteType, [string, string]> = {
  note: ['note', 'notes'],
  snippet: ['snippet', 'snippets'],
  url: ['link', 'links'],
  idea: ['idea', 'ideas'],
  document: ['document', 'documents'],
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (d: Date) => d.toISOString().slice(0, 10);

/** Answers a library question from the user's data, or returns null when the question isn't one. */
export async function answerLibraryQuestion(userId: string, question: string, now = new Date()): Promise<LibraryAnswer | null> {
  const owner = new Types.ObjectId(userId);
  const folders = (await Folder.find({ userId }, { name: 1 }).lean()).map((f) => ({ id: String(f._id), name: f.name }));
  const intent = parseLibraryQuestion(question, folders, now);
  if (!intent) return null;
  const text = (t: string) => ({ segments: [{ text: t, citations: [] }], sources: [] });

  if (intent.about === 'tags') {
    const rows = await Note.aggregate<{ _id: string; count: number }>([
      { $match: { userId: owner, deletedAt: null, archived: false } },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
    ]);
    if (!rows.length) return text('You aren’t using any tags yet.');
    const top = rows.slice(0, 10).map((r) => `#${r._id} (${r.count})`).join(', ');
    return text(`You use ${plural(rows.length, 'tag')}: ${top}${rows.length > 10 ? ', …' : ''}.`);
  }
  if (intent.about === 'folders') {
    const counts = await Note.aggregate<{ _id: unknown; count: number }>([
      { $match: { userId: owner, deletedAt: null, archived: false, folderId: { $ne: null } } },
      { $group: { _id: '$folderId', count: { $sum: 1 } } },
    ]);
    const by = new Map(counts.map((c) => [String(c._id), c.count]));
    if (!folders.length) return text('You don’t have any folders yet.');
    const list = folders.map((f) => `${f.name} (${by.get(f.id) ?? 0})`).join(', ');
    return text(`You have ${plural(folders.length, 'folder')}: ${list}.`);
  }

  const filter: FilterQuery<INote> = { userId: owner };
  if (intent.view === 'trash') filter.deletedAt = { $ne: null };
  else Object.assign(filter, { deletedAt: null, archived: intent.view === 'archived' });
  if (intent.types.length) filter.type = { $in: intent.types };
  if (intent.tag) filter.tags = intent.tag;
  if (intent.folder) filter.folderId = intent.folder === 'none' ? null : intent.folder.id;
  if (intent.pinned) filter.pinned = true;
  if (intent.favourite) filter.favourite = true;
  if (intent.since) filter[intent.dateField] = { $gte: intent.since.from, ...(intent.since.to ? { $lt: intent.since.to } : {}) };

  const filtered = !!(intent.types.length || intent.tag || intent.folder || intent.view !== 'active' || intent.pinned || intent.favourite || intent.since);

  // Plain "how many notes / items do I have": the whole picture.
  if (intent.action === 'count' && !filtered) {
    const [byType, archived, trash, favourites, pinned] = await Promise.all([
      Note.aggregate<{ _id: NoteType; count: number }>([{ $match: { ...filter } }, { $group: { _id: '$type', count: { $sum: 1 } } }]),
      Note.countDocuments({ userId, deletedAt: null, archived: true }),
      Note.countDocuments({ userId, deletedAt: { $ne: null } }),
      Note.countDocuments({ userId, deletedAt: null, archived: false, favourite: true }),
      Note.countDocuments({ userId, deletedAt: null, archived: false, pinned: true }),
    ]);
    const n = (t: NoteType) => byType.find((r) => r._id === t)?.count ?? 0;
    const total = byType.reduce((a, r) => a + r.count, 0);
    const parts = (Object.keys(LABEL) as NoteType[]).map((t) => plural(n(t), LABEL[t][0]));
    const extra = [favourites ? plural(favourites, 'favourite') : '', pinned ? `${pinned} pinned` : ''].filter(Boolean);
    return text(`You have ${plural(total, 'item')} in total: ${parts.join(', ')}. ${archived} archived, ${trash} in trash.${extra.length ? ` ${extra.join(', ')}.` : ''}`);
  }

  const total = await Note.countDocuments(filter);
  const noun = intent.types.length
    ? intent.types.map((t) => LABEL[t][total === 1 ? 0 : 1]).join(' and ')
    : total === 1 ? 'item' : 'items';
  const adjectives = [intent.view === 'archived' ? 'archived' : '', intent.pinned ? 'pinned' : '', intent.favourite ? 'favourite' : ''].filter(Boolean).join(' ');
  const after = [
    intent.view === 'trash' ? 'in the trash' : '',
    intent.tag ? `tagged #${intent.tag}` : '',
    intent.folder ? (intent.folder === 'none' ? 'that aren’t in a folder' : `in the folder “${intent.folder.name}”`) : '',
    intent.since ? `${intent.dateField === 'updatedAt' ? 'edited' : 'added'} ${intent.since.label}` : '',
  ].filter(Boolean).join(' ');
  const phrase = `${adjectives ? `${adjectives} ` : ''}${noun}${after ? ` ${after}` : ''}`;

  const showLimit = intent.action === 'list' ? intent.limit : 5;
  const wantList = (intent.action === 'list' || total <= 5) && total > 0;
  const notes = wantList
    ? await Note.find(filter, { ...BRIEF_FIELDS, createdAt: 1, updatedAt: 1 })
        .sort(intent.recent || intent.action === 'list' ? { [intent.dateField]: -1 } : { updatedAt: -1 })
        .limit(showLimit)
        .lean()
    : [];

  let head: string;
  if (!total) head = `You don’t have any ${phrase.replace(/^(items?)\b/, 'items')}.`;
  else if (intent.action === 'count') head = `You have ${total} ${phrase}.${notes.length ? ` Here ${notes.length === 1 ? 'it is' : 'they are'}:` : ''}`;
  else if (intent.recent) head = `Your latest ${notes.length === 1 ? '' : `${notes.length} `}${phrase}:`;
  else head = `You have ${total} ${phrase}.${total > notes.length ? ` Here are the ${notes.length} most recent:` : ' Here they are:'}`;

  const segments: LibraryAnswer['segments'] = [{ text: head, citations: [] }];
  const sources: LibraryAnswer['sources'] = [];
  notes.forEach((nt, i) => {
    const b = brief(nt);
    sources.push({ noteId: b._id, title: b.title, type: b.type });
    const when = (intent.dateField === 'updatedAt' ? nt.updatedAt : nt.createdAt) as Date | undefined;
    segments.push({ text: `\n• ${b.title}${when ? ` (${LABEL[b.type as NoteType]?.[0] ?? b.type}, ${day(when)})` : ''}`, citations: [{ source: i, quote: b.preview || b.title }] });
  });
  return { segments, sources };
}
