import type { EmbeddingProvider } from './types';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

type Extractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
let extractor: Promise<Extractor> | null = null;

/**
 * Free, on-device sentence embeddings (384 dims). The model (~23 MB) downloads once on first use.
 * The library is imported lazily so processes that never embed locally (tests, OpenAI mode) skip it.
 */
function load(): Promise<Extractor> {
  extractor ??= import('@huggingface/transformers')
    .then(({ pipeline }) => pipeline('feature-extraction', MODEL, { dtype: 'q8' }) as unknown as Promise<Extractor>)
    .catch((e) => {
      extractor = null; // allow a later retry
      throw new Error(`Could not load the local embedding model: ${(e as Error).message}`);
    });
  return extractor;
}

export const localProvider: EmbeddingProvider = {
  name: 'local',
  model: MODEL,
  dims: 384,
  // MiniLM reads at most 256 word pieces (~200 tokens of English); longer text is silently cut off.
  chunkTokens: 200,
  chunkOverlapTokens: 40,
  costPerMillionTokens: 0,
  async embed(texts, signal) {
    const fe = await load();
    if (signal.aborted) throw new Error('Embedding aborted');
    const out = await fe(texts, { pooling: 'mean', normalize: true });
    return out.tolist();
  },
};
