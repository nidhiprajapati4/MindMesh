/** Pure ranking helpers shared by the vector store and search service. */

export function cosine(a: number[], b: number[]) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The unit-length average of several vectors (e.g. a note's chunk embeddings). */
export function meanVector(vectors: number[][]): number[] {
  const sum = new Array<number>(vectors[0]?.length ?? 0).fill(0);
  for (const v of vectors) for (let i = 0; i < v.length; i++) sum[i] += v[i];
  const len = Math.sqrt(sum.reduce((s, x) => s + x * x, 0)) || 1;
  return sum.map((x) => x / len);
}

/** Keeps the k best-scoring items, best first. */
export function topK<T extends { score: number }>(items: Iterable<T>, k: number): T[] {
  const best: T[] = [];
  for (const it of items) {
    if (best.length < k) {
      best.push(it);
      best.sort((x, y) => y.score - x.score);
    } else if (k > 0 && it.score > best[k - 1].score) {
      best[k - 1] = it;
      best.sort((x, y) => y.score - x.score);
    }
  }
  return best;
}

export const RRF_K = 60;

const STOPWORDS = new Set(
  'the and for with from into onto that this these those what when where which who whom whose why how does did done doing are was were been being have has had having can could should would will shall may might must not but nor yet our ours your yours their theirs them they its his her him she you about after again all also any because before both each few more most other some such than then there too very just only own same out off over under keep keeps get gets got make makes my me i a an to of in on at by is it do be as or if so no up'.split(' ')
);

const terms = (text: string) =>
  [...new Set((text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w)))];

/** Crude stem (retries → retri, timing → tim) so plurals and tenses still match by prefix. */
const stem = (w: string) => w.replace(/(ing|ies|es|ed|ly|s)$/, '') || w;

/**
 * How well a keyword hit actually covers the query: the number and share of the query's content
 * words that appear in the text. A note matching one incidental word of a long question is a
 * weak keyword hit.
 */
export function termCoverage(query: string, text: string) {
  const qs = terms(query);
  const haystack = text.toLowerCase();
  const matched = qs.filter((w) => haystack.includes(stem(w))).length;
  return { matched, share: qs.length ? matched / qs.length : 0 };
}

/** A keyword hit worth counting in hybrid search: it matches at least two, or half, of the query's content words. */
export const isStrongKeywordHit = (query: string, text: string) => {
  const c = termCoverage(query, text);
  return c.matched >= 2 || c.share >= 0.5;
};

/**
 * Reciprocal-rank fusion of ranked id lists: each list adds weight / (k + rank) per item, so items
 * ranked well by several lists rise to the top, and a more trusted list can count for more.
 * Returns ids best first with their fused score and which lists (by index) contained them.
 */
export function rrf(lists: string[][], k = RRF_K, weights: number[] = []) {
  const scores = new Map<string, { score: number; lists: number[] }>();
  lists.forEach((ids, li) =>
    ids.forEach((id, rank) => {
      const s = scores.get(id) ?? { score: 0, lists: [] };
      s.score += (weights[li] ?? 1) / (k + rank + 1);
      s.lists.push(li);
      scores.set(id, s);
    })
  );
  return [...scores.entries()].map(([id, s]) => ({ id, ...s })).sort((a, b) => b.score - a.score);
}
