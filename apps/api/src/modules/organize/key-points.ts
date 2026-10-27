import { embed } from '../../platform/ai-client';
import { sentences } from '../../platform/generation/quotes';
import { cosine } from '../search/rank';

/** Mutable only so the eval can sweep them. */
export const keyPointSettings = {
  /** Notes with fewer sentences than this are short enough to read as they are. */
  minSentences: 4,
  /** Trade-off between "represents the note" (1) and "differs from points already picked" (0).
   *  0.5 covered 63% of the eval's key facts vs 50% at 0.7–0.8 (docs/eval/phase5.md). */
  diversity: 0.5,
  /** Only the first sentences are scored, to keep very long documents quick. */
  maxSentences: 80,
};

/**
 * Extractive summary: picks 2–3 of the note's own sentences that best represent the whole note
 * (closest to its note vector) without repeating each other (maximal marginal relevance).
 * Returned in their original order. No language model; uses the local embedding model.
 */
export async function keyPointsFor(userId: string, text: string, noteVector: number[]): Promise<string[]> {
  const all = sentences(text).slice(0, keyPointSettings.maxSentences);
  if (all.length < keyPointSettings.minSentences) return [];
  const want = all.length >= 8 ? 3 : 2;

  const { vectors } = await embed(all, { userId, purpose: 'index' });
  const relevance = vectors.map((v) => cosine(v, noteVector));
  const picked: number[] = [];
  while (picked.length < want) {
    let best = -1;
    let bestScore = -Infinity;
    for (let i = 0; i < all.length; i++) {
      if (picked.includes(i)) continue;
      const redundancy = picked.length ? Math.max(...picked.map((p) => cosine(vectors[i], vectors[p]))) : 0;
      const score = keyPointSettings.diversity * relevance[i] - (1 - keyPointSettings.diversity) * redundancy;
      if (score > bestScore) [best, bestScore] = [i, score];
    }
    picked.push(best);
  }
  return picked.sort((a, b) => a - b).map((i) => all[i]);
}
