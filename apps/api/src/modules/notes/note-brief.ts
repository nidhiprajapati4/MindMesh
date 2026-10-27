import { listQuerySchema } from './notes.schema';
import { baseFilter } from './notes.service';

/** Notes the user sees in "All items": theirs, not trashed, not archived. */
export const activeFilter = (userId: string) => baseFilter(userId, listQuerySchema.parse({ view: 'active' }));

const preview = (n: { content?: string | null; metadata?: { description?: string | null } | null }) =>
  (n.content || n.metadata?.description || '').replace(/\s+/g, ' ').trim().slice(0, 140);

/** The small view of a note sent in lists of related, duplicate and linked notes. */
export type Brief = { _id: string; title: string; type: string; preview: string };
export const brief = (n: { _id: unknown; title: string; type: string; content?: string | null; metadata?: { description?: string | null } | null }): Brief => ({
  _id: String(n._id),
  title: n.title || 'Untitled',
  type: n.type,
  preview: preview(n),
});

/** Fields `brief` needs, for query projections. */
export const BRIEF_FIELDS = { title: 1, type: 1, content: 1, 'metadata.description': 1 } as const;
