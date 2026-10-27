/** A note handed to the answer model as a citable document. */
export type SourceDoc = { title: string; text: string };

/** A passage the answer quotes; `docIndex` points into the request's `docs`. */
export type AnswerCitation = { docIndex: number; quote: string };

/** Events emitted while an answer is being written, in order. */
export type AnswerEvent =
  | { type: 'text'; text: string }
  | { type: 'citation'; docIndex: number; quote: string };

/** One run of answer text with the citations that back it. */
export type AnswerSegment = { text: string; citations: AnswerCitation[] };

export type AnswerRequest = {
  /** Earlier turns of this conversation, oldest first (answers as plain text). */
  history: { question: string; answer: string }[];
  question: string;
  docs: SourceDoc[];
};

export type AnswerResult = {
  segments: AnswerSegment[];
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export interface AnswerProvider {
  name: string;
  model: string;
  /** USD per 1M input / output tokens, for the per-call cost estimate. */
  costPerMillion: { input: number; output: number };
  answer(req: AnswerRequest, opts: { signal: AbortSignal; onEvent: (e: AnswerEvent) => void }): Promise<AnswerResult>;
}

/** The model declined to answer (safety refusal). */
export class AnswerRefusedError extends Error {}

export const answerText = (r: { segments: AnswerSegment[] }) => r.segments.map((s) => s.text).join('');
