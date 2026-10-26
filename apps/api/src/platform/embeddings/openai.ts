import { RetryableError, type EmbeddingProvider } from './types';

const DIMS: Record<string, number> = { 'text-embedding-3-small': 1536, 'text-embedding-3-large': 3072, 'text-embedding-ada-002': 1536 };
const COST: Record<string, number> = { 'text-embedding-3-small': 0.02, 'text-embedding-3-large': 0.13, 'text-embedding-ada-002': 0.1 };

export function openaiProvider(apiKey: string, model = 'text-embedding-3-small'): EmbeddingProvider {
  return {
    name: 'openai',
    model,
    dims: DIMS[model] ?? 1536,
    chunkTokens: 800,
    chunkOverlapTokens: 100,
    costPerMillionTokens: COST[model] ?? 0.02,
    async embed(texts, signal) {
      let res: Response;
      try {
        res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, input: texts }),
          signal,
        });
      } catch (e) {
        throw new RetryableError(`OpenAI request failed: ${(e as Error).message}`);
      }
      if (res.status === 429 || res.status >= 500) throw new RetryableError(`OpenAI responded ${res.status}`);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(`OpenAI responded ${res.status}: ${body.error?.message ?? 'request rejected'}`);
      }
      const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
      return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}
