export interface EmbeddingProvider {
  /** Short provider id, e.g. "local". */
  name: string;
  /** Stored on every chunk; search only compares vectors from the same model. */
  model: string;
  dims: number;
  /** Chunk size suited to the model's input window (local models see far less text than OpenAI's). */
  chunkTokens: number;
  chunkOverlapTokens: number;
  /** USD per 1M input tokens, for the per-call cost estimate. */
  costPerMillionTokens: number;
  /** Returns one unit-length vector per input text, in order. */
  embed(texts: string[], signal: AbortSignal): Promise<number[][]>;
}

/** A provider error the caller may retry (rate limit, 5xx, network). */
export class RetryableError extends Error {
  retryable = true;
}

export const normalize = (v: number[]) => {
  const len = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / len);
};
