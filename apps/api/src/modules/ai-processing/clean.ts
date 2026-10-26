import { decodeEntities } from '../../lib/html';

// Short lines matching these are site chrome, not content.
const BOILERPLATE = /^(skip to (main )?content|accept( all)? cookies?|we use cookies.*|cookie (settings|policy)|privacy policy|terms (of (use|service)|& conditions)|all rights reserved.*|©.*|copyright .*|sign (in|up)|log ?in|subscribe( now)?|share( this)?( on .*)?|menu|search|back to top|advertisement|related (posts|articles)|follow us.*|read more)$/i;

/** Normalises whitespace (keeps paragraph breaks) and drops boilerplate lines. */
export function cleanText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/ {2,}/g, ' ').trim())
    .filter((line) => !(line.length < 80 && BOILERPLATE.test(line)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const STRIP_ELEMENTS = ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'form', 'nav', 'header', 'footer', 'aside', 'button', 'select'];

/**
 * Readability-style text extraction: drop scripts, navigation and page chrome, prefer the
 * <article> or <main> region, and turn block elements into line breaks.
 */
export function htmlToText(html: string): string {
  let h = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of STRIP_ELEMENTS) h = h.replace(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi'), ' ');

  const region = (tag: string) => {
    const parts = h.match(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'));
    return parts?.join('\n');
  };
  const main = region('article') ?? region('main') ?? /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(h)?.[1] ?? h;

  const text = main
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/?(p|div|section|li|ul|ol|h[1-6]|tr|table|blockquote|pre|dd|dt|figcaption)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return cleanText(decodeEntities(text));
}
