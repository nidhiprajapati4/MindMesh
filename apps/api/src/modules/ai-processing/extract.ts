import { createHash } from 'node:crypto';
import type { INote } from '../../models/Note';
import { fetchHtml } from '../notes/url-metadata';
import { cleanText, htmlToText } from './clean';

type Searchable = Pick<INote, 'type' | 'title' | 'content' | 'sourceUrl'> & { metadata?: { description?: string | null } | null };

/** The fields whose change means the item must be re-embedded. Tags, pins and folders don't count. */
export function contentHash(n: Searchable): string {
  return createHash('sha256')
    .update([n.type, n.title ?? '', n.content ?? '', n.sourceUrl ?? '', n.metadata?.description ?? ''].join('\u0000'))
    .digest('hex');
}

/** Whether an item has any text worth embedding. */
export const hasSearchableText = (n: Searchable) => !!(n.title?.trim() || n.content?.trim() || n.sourceUrl || n.metadata?.description?.trim());

/**
 * The body text to embed (the title is added to every chunk separately).
 * Notes, snippets, ideas and uploaded documents use their content. Links fetch the page's
 * readable text through the SSRF guard; if the page can't be read, the saved description is used.
 */
export async function extractText(n: Searchable): Promise<string> {
  const description = n.metadata?.description?.trim() ?? '';
  if (n.type === 'url' && n.sourceUrl) {
    const page = await fetchHtml(n.sourceUrl)
      .then(({ html }) => htmlToText(html))
      .catch(() => '');
    return cleanText([description, n.content, page].filter(Boolean).join('\n\n'));
  }
  return cleanText([n.content, description].filter(Boolean).join('\n\n'));
}
