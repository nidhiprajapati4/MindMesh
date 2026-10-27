/**
 * The only entry point for model calls (ADR-006). Everything that embeds or generates goes
 * through here, so timeouts, retries, quota checks, cost estimates and usage logging live in one place.
 */
import { env } from '../config/env';
import { fakeProvider } from './embeddings/fake';
import { localProvider } from './embeddings/local';
import { openaiProvider } from './embeddings/openai';
import type { EmbeddingProvider } from './embeddings/types';
import { anthropicAnswerProvider } from './generation/anthropic';
import { fakeAnswerProvider } from './generation/fake';
import { quotesAnswerProvider } from './generation/quotes';
import type { AnswerEvent, AnswerProvider, AnswerRequest, AnswerResult } from './generation/types';
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

/**
 * Settles as soon as `signal` aborts, even if `p` never does (the abort signal alone can't stop
 * CPU-bound local work or a provider that ignores it). Rejects with the abort reason if one was given.
 */
function withTimeout<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('AI call timed out'), { name: 'TimeoutError' }));
    // Always attach to `p` first: if it rejects after we gave up, that must not be an unhandled rejection.
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
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

// ---------------------------------------------------------------------------------------------
// Answer generation (Phase 4)

/**
 * firstTokenMs: longest wait for the first streamed text, so a stuck request fails fast.
 * totalMs: hard cap on a whole answer. Mutable only so tests can shorten them.
 */
export const answerTimeouts = { firstTokenMs: TIMEOUT_MS, totalMs: 120_000 };
/** Output allowance reserved against the budget before the call (the real count is recorded after). */
const ANSWER_OUTPUT_RESERVE = 1000;

let answerer: AnswerProvider | null = null;

export type AnswerProviderName = 'anthropic' | 'quotes' | 'fake';

/**
 * Which answer mode is configured: Claude when a key is set, otherwise free "smart quotes"
 * (sentences picked from the notes by meaning, no language model). `fake` only when asked for (tests).
 */
export function answerSetup(): { available: boolean; provider: AnswerProviderName; model: string } {
  if (answerer) return { available: true, provider: answerer.name as AnswerProviderName, model: answerer.model };
  const provider = env.ANSWER_PROVIDER ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : 'quotes');
  const model =
    provider === 'anthropic' ? env.ANSWER_MODEL : provider === 'quotes' ? `quotes (${embeddingProvider().model})` : fakeAnswerProvider.model;
  return { available: true, provider, model };
}

export function answerProvider(): AnswerProvider {
  if (answerer) return answerer;
  const { provider } = answerSetup();
  answerer =
    provider === 'anthropic' ? anthropicAnswerProvider(env.ANTHROPIC_API_KEY!, env.ANSWER_MODEL) :
    provider === 'quotes' ? quotesAnswerProvider((texts, signal) => embeddingProvider().embed(texts, signal), embeddingProvider().model) :
    fakeAnswerProvider;
  return answerer;
}

/** Tests only: swap in an answer provider. */
export function setAnswerProvider(p: AnswerProvider | null) {
  answerer = p;
}

export type GenerateContext = { userId: string; signal?: AbortSignal; onEvent: (e: AnswerEvent) => void };

/**
 * Writes an answer from the given notes, streaming events through `onEvent`.
 * Budget-checked before the call and charged with the real token counts after. Transient
 * failures are retried only while nothing has been streamed yet, so the user never sees
 * text from two attempts.
 */
export async function generateAnswer(req: AnswerRequest, ctx: GenerateContext): Promise<AnswerResult & { costUsd: number; ms: number }> {
  const p = answerProvider();
  const prompt = [req.question, ...req.history.flatMap((h) => [h.question, h.answer]), ...req.docs.map((d) => d.title + d.text)].join('');
  await assertWithinBudget(ctx.userId, estimateTokens(prompt) + ANSWER_OUTPUT_RESERVE);

  const started = Date.now();
  for (let attempt = 1; ; attempt++) {
    let streamed = false;
    let streamedChars = 0;
    const controller = new AbortController();
    const abort = (reason: string) => controller.abort(Object.assign(new Error(reason), { name: 'TimeoutError' }));
    const onCallerAbort = () => controller.abort(ctx.signal?.reason);
    ctx.signal?.addEventListener('abort', onCallerAbort, { once: true });
    const firstToken = setTimeout(() => abort('AI call timed out'), answerTimeouts.firstTokenMs);
    const total = setTimeout(() => abort('AI answer took too long'), answerTimeouts.totalMs);
    try {
      // Raced against the abort signal, so a provider that ignores cancellation can't hang the request.
      const result = await withTimeout(
        p.answer(req, {
          signal: controller.signal,
          onEvent: (e) => {
            if (controller.signal.aborted) return; // nothing more reaches the caller after a cancel or timeout
            if (!streamed) clearTimeout(firstToken);
            streamed = true;
            if (e.type === 'text') streamedChars += e.text.length;
            ctx.onEvent(e);
          },
        }),
        controller.signal
      );
      const costUsd = +((result.inputTokens * p.costPerMillion.input + result.outputTokens * p.costPerMillion.output) / 1e6).toFixed(6);
      await recordUsage(ctx.userId, { gen: result.inputTokens + result.outputTokens });
      if (env.NODE_ENV !== 'test') {
        console.log(
          JSON.stringify({
            evt: 'ai.answer', userId: ctx.userId, provider: p.name, model: result.model, docs: req.docs.length,
            inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd, ms: Date.now() - started, attempts: attempt,
          })
        );
      }
      return { ...result, costUsd, ms: Date.now() - started };
    } catch (e) {
      const err = controller.signal.aborted && !ctx.signal?.aborted ? controller.signal.reason : e;
      const giveUp = streamed || ctx.signal?.aborted || attempt > MAX_RETRIES || !isRetryable(err);
      // A stopped or failed answer was still billed for what the model read and wrote, so it
      // counts against the budget too (estimated, as the real usage never arrived). Otherwise
      // pressing Stop repeatedly would get around the daily limit.
      if (giveUp && streamed) {
        await recordUsage(ctx.userId, { gen: estimateTokens(prompt) + Math.ceil(streamedChars / 4) }).catch(() => undefined);
      }
      if (giveUp) throw err;
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
    } finally {
      clearTimeout(firstToken);
      clearTimeout(total);
      ctx.signal?.removeEventListener('abort', onCallerAbort);
    }
  }
}
