/**
 * The only entry point for model calls (ADR-006). Everything that embeds or generates goes
 * through here, so timeouts, retries, quota checks, cost estimates and usage logging live in one place.
 */
import { env } from '../config/env';
import { fakeProvider } from './embeddings/fake';
import { localProvider } from './embeddings/local';
import { openaiProvider } from './embeddings/openai';
import type { EmbeddingProvider } from './embeddings/types';
import { assertWithinBudget, recordUsage } from './quota';
import { estimateTokens } from './tokens';

export const TIMEOUT_MS = 20_000;
export const MAX_RETRIES = 3;
const BASE_DELAY_MS = 500;

let provider: EmbeddingProvider | null = null;

export function embeddingProvider(): EmbeddingProvider {
  provider ??=
    env.EMBEDDING_PROVIDER === 'openai' ? openaiProvider(env.OPENAI_API_KEY!, env.EMBEDDING_MODEL) :
    env.EMBEDDING_PROVIDER === 'fake' ? fakeProvider :
    localProvider;
  return provider;
}

/** Tests only: swap in a provider (e.g. one that fails on purpose). */
export function setEmbeddingProvider(p: EmbeddingProvider | null) {
  provider = p;
}

export { estimateTokens };

/** Delay before retry n (1-based): 500 ms, 1 s, 2 s … plus up to 25% jitter. */
export const backoffMs = (attempt: number, base = BASE_DELAY_MS) => base * 2 ** (attempt - 1) * (1 + Math.random() * 0.25);

const isRetryable = (e: unknown) => (e as { retryable?: boolean })?.retryable === true || (e as Error)?.name === 'TimeoutError';

async function withRetries<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<{ value: T; attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(AbortSignal.timeout(TIMEOUT_MS)), attempts: attempt };
    } catch (e) {
      if (attempt > MAX_RETRIES || !isRetryable(e)) throw e;
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    }
  }
}

/** Runs one provider call under the 20 s timeout (the abort signal alone can't stop CPU-bound local work). */
function withTimeout<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('AI call timed out'), { name: 'TimeoutError' }));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export type EmbedResult = { vectors: number[][]; model: string; dims: number; tokens: number };

/**
 * Embeds texts for a user. Checks the daily budget first (QuotaExceededError → 429),
 * records the tokens afterwards, and logs model, tokens, cost and latency (never the text).
 */
export async function embed(texts: string[], ctx: { userId: string; purpose: 'index' | 'query' }): Promise<EmbedResult> {
  const p = embeddingProvider();
  const tokens = texts.reduce((n, t) => n + estimateTokens(t), 0);
  await assertWithinBudget(ctx.userId, tokens);

  const started = Date.now();
  const { value: vectors, attempts } = await withRetries((signal) => withTimeout(p.embed(texts, signal), signal));
  if (vectors.length !== texts.length || vectors.some((v) => v.length !== p.dims)) {
    throw new Error(`Embedding provider returned an unexpected shape (expected ${texts.length}×${p.dims})`);
  }
  await recordUsage(ctx.userId, { embed: tokens });

  if (env.NODE_ENV !== 'test') {
    console.log(
      JSON.stringify({
        evt: 'ai.embed', userId: ctx.userId, purpose: ctx.purpose, provider: p.name, model: p.model, inputs: texts.length,
        tokens, costUsd: +((tokens / 1e6) * p.costPerMillionTokens).toFixed(6), ms: Date.now() - started, attempts,
      })
    );
  }
  return { vectors, model: p.model, dims: p.dims, tokens };
}

/** Text generation arrives in Phase 4 (RAG answers); the entry point exists so callers have one place to go. */
export async function generate(_prompt: string, _ctx: { userId: string }): Promise<never> {
  throw new Error('generate() is not available until Phase 4');
}
