import { estimateTokens } from '../tokens';
import type { AnswerEvent, AnswerProvider, AnswerSegment } from './types';

export const FAKE_NOT_FOUND = "I couldn't find anything about that in your notes.";

const firstSentence = (text: string) => (text.replace(/\s+/g, ' ').trim().match(/^.*?[.!?](\s|$)/)?.[0] ?? text).trim().slice(0, 300);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);

/**
 * Deterministic stand-in for the answer model, used in tests and until an API key is set.
 * It "answers" by quoting the first sentence of each document that shares a word with the
 * question (up to two), citing each one. Streams in small pieces like a real model.
 */
export const fakeAnswerProvider: AnswerProvider = {
  name: 'fake',
  model: 'fake-answerer',
  costPerMillion: { input: 0, output: 0 },
  async answer(req, { signal, onEvent }) {
    const q = words(req.question);
    const picked = req.docs
      .map((d, docIndex) => ({ d, docIndex }))
      .filter(({ d }) => [...words(`${d.title} ${d.text}`)].some((w) => q.has(w)))
      .slice(0, 2);

    const segments: AnswerSegment[] = picked.length
      ? [
          { text: 'From your notes: ', citations: [] },
          ...picked.map(({ d, docIndex }, i) => {
            const quote = firstSentence(d.text || d.title);
            return { text: (i ? ' ' : '') + quote, citations: [{ docIndex, quote }] };
          }),
        ]
      : [{ text: FAKE_NOT_FOUND, citations: [] }];

    const emit = (e: AnswerEvent) => {
      if (signal.aborted) throw Object.assign(new Error('Answer aborted'), { name: 'AbortError' });
      onEvent(e);
    };
    for (const seg of segments) {
      for (const piece of seg.text.match(/.{1,24}/gs) ?? []) {
        emit({ type: 'text', text: piece });
        await new Promise((r) => setImmediate(r));
      }
      for (const c of seg.citations) emit({ type: 'citation', ...c });
    }

    const prompt = [req.question, ...req.history.flatMap((h) => [h.question, h.answer]), ...req.docs.map((d) => d.title + d.text)].join('\n');
    return {
      segments,
      model: this.model,
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens(segments.map((s) => s.text).join('')),
    };
  },
};
