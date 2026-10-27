import { cosine } from '../../modules/search/rank';
import { estimateTokens } from '../tokens';
import type { AnswerEvent, AnswerProvider, AnswerSegment } from './types';

export const QUOTES_NOT_FOUND = "I couldn't find a sentence in your notes that answers this directly.";

/**
 * Tuning (mutable only so the eval can sweep it), chosen on apps/api/eval/ask (docs/eval/phase4.md):
 * minSimilarity — a sentence must be at least this close to the question to be quoted. Results
 *   are flat from 0.25 to 0.45 and drop at 0.50; 0.35 keeps a safe margin from that cliff.
 * maxGapFromBest — quotes from *other* notes must score within this much of the best one, so a
 *   loosely related sentence from another note isn't added after the real answer. 0.10 lifted
 *   citation precision from 89% to 100% with every fact kept; 0.05 started dropping facts.
 * sameNoteMinSimilarity — a second sentence from the best-matching note needs only this much:
 *   the note is already known to be relevant, and its other sentence often holds the "how".
 *   "How do I calm my nerves before a presentation?" scores 0.67 against "Five rounds calms
 *   nerves…" but only ~0.20 against "Inhale for four seconds…", the actual technique; 0.15
 *   keeps that with some margin. The eval showed no change from 0.10 to 0.35.
 * maxQuotes / maxPerNote — how many sentences, and how many from one note.
 */
export const quoteSettings = { minSimilarity: 0.35, maxGapFromBest: 0.1, sameNoteMinSimilarity: 0.15, maxQuotes: 3, maxPerNote: 2 };

type Embed = (texts: string[], signal: AbortSignal) => Promise<number[][]>;

/** Sentence-ish pieces: split on sentence ends and line breaks, dropping fragments. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*•]\s*/, '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length >= 12 && /[a-z]/i.test(s));
}

/**
 * Free answer mode: no language model. Picks the sentences from the retrieved notes that are
 * closest in meaning to the question (using the same local embedding model as search) and
 * quotes them, each with a citation. It can't invent anything; it also can't summarise.
 */
export function quotesAnswerProvider(embed: Embed, model: string): AnswerProvider {
  return {
    name: 'quotes',
    model: `quotes (${model})`,
    costPerMillion: { input: 0, output: 0 },
    async answer(req, { signal, onEvent }) {
      // Each sentence is embedded with its note's title, so "It is ready when it doubles" still
      // reads as being about sourdough; the quote itself is the bare sentence.
      const candidates = req.docs.flatMap((d, docIndex) => sentences(d.text).map((s) => ({ docIndex, sentence: s, context: `${d.title}: ${s}` })));
      let segments: AnswerSegment[] = [];
      if (candidates.length) {
        const [q, ...vectors] = await embed([req.question, ...candidates.map((c) => c.context)], signal);
        const ranked = candidates.map((c, i) => ({ ...c, score: cosine(q, vectors[i]) })).sort((a, b) => b.score - a.score);
        const picked: typeof ranked = [];
        const perNote = new Map<number, number>();
        for (const c of ranked) {
          if (picked.length >= quoteSettings.maxQuotes) break;
          const best = picked[0];
          if (!best) {
            if (c.score < quoteSettings.minSimilarity) break; // nothing is close enough: decline
          } else if (c.docIndex === best.docIndex) {
            // A second sentence from the best note only has to be loosely relevant: it usually completes the answer.
            if (c.score < quoteSettings.sameNoteMinSimilarity) continue;
          } else if (c.score < quoteSettings.minSimilarity || c.score < best.score - quoteSettings.maxGapFromBest) {
            continue; // another note's sentence must be close to the question and nearly as good as the best quote
          }
          if ((perNote.get(c.docIndex) ?? 0) >= quoteSettings.maxPerNote || picked.some((p) => p.sentence === c.sentence)) continue;
          perNote.set(c.docIndex, (perNote.get(c.docIndex) ?? 0) + 1);
          picked.push(c);
        }
        if (picked.length) {
          segments = [
            { text: 'From your notes:', citations: [] },
            ...picked.map((p) => ({ text: `\n- ${p.sentence}`, citations: [{ docIndex: p.docIndex, quote: p.sentence }] })),
          ];
        }
      }
      if (!segments.length) segments = [{ text: QUOTES_NOT_FOUND, citations: [] }];

      for (const seg of segments) {
        if (signal.aborted) throw Object.assign(new Error('Answer aborted'), { name: 'AbortError' });
        onEvent({ type: 'text', text: seg.text } satisfies AnswerEvent);
        for (const c of seg.citations) onEvent({ type: 'citation', ...c });
      }
      return {
        segments,
        model: this.model,
        inputTokens: estimateTokens([req.question, ...candidates.map((c) => c.context)].join(' ')),
        outputTokens: estimateTokens(segments.map((s) => s.text).join('')),
      };
    },
  };
}
