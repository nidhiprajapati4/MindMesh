import { estimateTokens } from '../../platform/tokens';

export type ChunkOptions = { maxTokens: number; overlapTokens: number; title?: string };

const CHARS_PER_TOKEN = 4;

/** Breaks text into units no larger than `maxChars`: paragraphs, then sentences, then word-bounded slices. */
function units(text: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)) {
    if (para.length <= maxChars) {
      out.push(para);
      continue;
    }
    for (const sentence of para.split(/(?<=[.!?])\s+/)) {
      let s = sentence.trim();
      while (s.length > maxChars) {
        const cut = s.lastIndexOf(' ', maxChars);
        const at = cut > maxChars / 2 ? cut : maxChars;
        out.push(s.slice(0, at).trim());
        s = s.slice(at).trim();
      }
      if (s) out.push(s);
    }
  }
  return out;
}

/** The tail of `text` of at most `maxChars`, starting at a word boundary. */
function tail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const t = text.slice(-maxChars);
  const space = t.indexOf(' ');
  return space >= 0 ? t.slice(space + 1) : t;
}

/**
 * Splits text into overlapping chunks of about `maxTokens`, breaking on paragraph boundaries first.
 * Each chunk starts with the item's title so it keeps its context when retrieved on its own.
 */
export function chunkText(text: string, { maxTokens, overlapTokens, title }: ChunkOptions): string[] {
  const prefix = title?.trim() ? `${title.trim()}\n\n` : '';
  const maxChars = Math.max(200, maxTokens * CHARS_PER_TOKEN - prefix.length);
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  const body = text.trim();
  if (!body) return prefix ? [prefix.trim()] : [];

  const chunks: string[] = [];
  let current = '';
  // Every unit fits in maxChars on its own, so `current` only overflows once it holds earlier text.
  for (const unit of units(body, maxChars)) {
    const joined = current ? `${current}\n\n${unit}` : unit;
    if (joined.length <= maxChars) {
      current = joined;
      continue;
    }
    chunks.push(current);
    // Seed the next chunk with the end of this one so text spanning the boundary is findable in both.
    const carry = tail(current, overlapChars);
    current = carry && carry.length + unit.length + 2 <= maxChars ? `${carry}\n\n${unit}` : unit;
  }
  if (current) chunks.push(current);

  return chunks.map((c) => prefix + c);
}

export const chunkTokens = (chunk: string) => estimateTokens(chunk);
