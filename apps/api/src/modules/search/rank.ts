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

/**
 * Reciprocal-rank fusion of ranked id lists: each list adds 1 / (k + rank) per item, so items
 * ranked well by several lists rise to the top. Returns ids best first with their fused score
 * and which lists (by index) contained them.
 */
export function rrf(lists: string[][], k = RRF_K) {
  const scores = new Map<string, { score: number; lists: number[] }>();
  lists.forEach((ids, li) =>
    ids.forEach((id, rank) => {
      const s = scores.get(id) ?? { score: 0, lists: [] };
      s.score += 1 / (k + rank + 1);
      s.lists.push(li);
      scores.set(id, s);
    })
  );
  return [...scores.entries()].map(([id, s]) => ({ id, ...s })).sort((a, b) => b.score - a.score);
}
