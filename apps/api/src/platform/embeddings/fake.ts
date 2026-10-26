import { createHash } from 'node:crypto';
import { normalize, type EmbeddingProvider } from './types';

// Large enough that unrelated words rarely share a bucket.
const DIMS = 1024;

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');

/**
 * Deterministic hashed bag-of-words vectors for tests: texts sharing words score higher.
 * No network, no model download, identical results on every run.
 */
export const fakeProvider: EmbeddingProvider = {
  name: 'fake',
  model: 'fake-bow-1024',
  dims: DIMS,
  chunkTokens: 200,
  chunkOverlapTokens: 40,
  costPerMillionTokens: 0,
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array<number>(DIMS).fill(0);
      for (const word of text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []) {
        v[createHash('md5').update(stem(word)).digest().readUInt16BE(0) % DIMS] += 1;
      }
      return normalize(v);
    });
  },
};
