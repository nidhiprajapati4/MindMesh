import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fakeProvider } from '../../platform/embeddings/fake';
import { looksLikeFollowUp } from '../ask/follow-up';
import { cosine, isStrongKeywordHit, rrf, termCoverage, topK } from '../search/rank';
import { chunkText } from './chunk';
import { cleanText, htmlToText } from './clean';
import { contentHash, hasSearchableText } from './extract';
import { retryDelayMs } from './jobs';

const para = (n: number, word = 'lorem') => Array.from({ length: n }, (_, i) => `${word}${i}`).join(' ') + '.';

describe('chunkText', () => {
  it('CHUNK-01 short text is one chunk with the title prefixed', () => {
    assert.deepEqual(chunkText('Use backoff.', { maxTokens: 200, overlapTokens: 40, title: 'Retry' }), ['Retry\n\nUse backoff.']);
  });

  it('CHUNK-02 empty body keeps just the title; nothing at all gives no chunks', () => {
    assert.deepEqual(chunkText('  ', { maxTokens: 200, overlapTokens: 40, title: 'Only a title' }), ['Only a title']);
    assert.deepEqual(chunkText('', { maxTokens: 200, overlapTokens: 40 }), []);
  });

  it('CHUNK-03 chunks stay within the size limit and split on paragraph boundaries', () => {
    const paras = Array.from({ length: 12 }, (_, i) => para(30, `p${i}w`)); // ~200 chars each
    const chunks = chunkText(paras.join('\n\n'), { maxTokens: 200, overlapTokens: 0 });
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(c.length <= 800, `chunk of ${c.length} chars`);
    // With no overlap, every chunk is made of whole paragraphs.
    for (const c of chunks) for (const piece of c.split('\n\n')) assert.ok(paras.includes(piece), 'paragraph was split');
    assert.equal(chunks.join('\n\n'), paras.join('\n\n'), 'no text lost or duplicated');
  });

  it('CHUNK-04 consecutive chunks overlap', () => {
    const paras = Array.from({ length: 10 }, (_, i) => para(30, `p${i}w`));
    const chunks = chunkText(paras.join('\n\n'), { maxTokens: 200, overlapTokens: 40 });
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1].slice(-60).split(' ').slice(1).join(' ');
      assert.ok(chunks[i].includes(prevTail), `chunk ${i} does not repeat the end of chunk ${i - 1}`);
    }
  });

  it('CHUNK-05 a huge paragraph is split by sentences, then by words', () => {
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about topic ${i}.`).join(' ');
    const noPunctuation = 'word '.repeat(2000);
    for (const text of [sentences, noPunctuation]) {
      const chunks = chunkText(text, { maxTokens: 100, overlapTokens: 10 });
      assert.ok(chunks.length > 1);
      for (const c of chunks) assert.ok(c.length <= 400, `chunk of ${c.length} chars`);
    }
  });
});

describe('cleaning', () => {
  it('CLEAN-01 normalises whitespace but keeps paragraph breaks', () => {
    assert.equal(cleanText('a  \t b\r\n\r\n\r\n\r\nc d'), 'a b\n\nc d');
  });

  it('CLEAN-02 drops short boilerplate lines', () => {
    assert.equal(cleanText('Accept cookies\nReal content here\nAll rights reserved 2026\nPrivacy Policy'), 'Real content here');
  });

  it('CLEAN-03 htmlToText prefers <article> and strips scripts, nav and footer', () => {
    const html = `<html><head><style>.x{}</style></head><body>
      <nav>Home | About</nav><header>Site header</header>
      <article><h1>Backoff &amp; jitter</h1><p>Retry with   delays.</p><script>evil()</script><p>Second&nbsp;para</p></article>
      <aside>Ads</aside><footer>© 2026</footer></body></html>`;
    const text = htmlToText(html);
    assert.match(text, /Backoff & jitter/);
    assert.match(text, /Retry with delays\./);
    assert.match(text, /Second para/);
    for (const junk of ['Home', 'Site header', 'evil', 'Ads', '©']) assert.ok(!text.includes(junk), `kept "${junk}"`);
  });

  it('CLEAN-04 falls back to <body> when there is no article or main', () => {
    assert.equal(htmlToText('<body><div>Hello</div><div>World</div></body>'), 'Hello\n\nWorld');
  });
});

describe('content hash', () => {
  const base = { type: 'note' as const, title: 'T', content: 'C', sourceUrl: null, metadata: {} };

  it('HASH-01 is stable and changes only with searchable fields', () => {
    assert.equal(contentHash(base), contentHash({ ...base }));
    assert.notEqual(contentHash(base), contentHash({ ...base, content: 'C2' }));
    assert.notEqual(contentHash(base), contentHash({ ...base, title: 'T2' }));
    assert.notEqual(contentHash(base), contentHash({ ...base, type: 'idea' }));
    assert.notEqual(contentHash(base), contentHash({ ...base, metadata: { description: 'd' } }));
    // Field boundaries matter: "ab"+"c" differs from "a"+"bc".
    assert.notEqual(contentHash({ ...base, title: 'ab', content: 'c' }), contentHash({ ...base, title: 'a', content: 'bc' }));
  });

  it('HASH-02 empty items have nothing to embed', () => {
    assert.equal(hasSearchableText({ ...base, title: ' ', content: '' }), false);
    assert.equal(hasSearchableText({ ...base, title: '', content: '', sourceUrl: 'https://x.test' }), true);
  });
});

describe('ranking helpers', () => {
  it('RANK-01 cosine similarity', () => {
    assert.equal(cosine([1, 0], [1, 0]), 1);
    assert.equal(cosine([1, 0], [0, 1]), 0);
    assert.equal(cosine([0, 0], [1, 0]), 0);
    assert.ok(Math.abs(cosine([1, 1], [2, 2]) - 1) < 1e-12);
  });

  it('RANK-02 topK keeps the best k in order', () => {
    const items = [0.1, 0.9, 0.5, 0.7, 0.3].map((score, i) => ({ id: i, score }));
    assert.deepEqual(topK(items, 3).map((x) => x.score), [0.9, 0.7, 0.5]);
    assert.equal(topK(items, 10).length, 5);
    assert.deepEqual(topK(items, 0), []);
  });

  it('RANK-04 weighted fusion lets a trusted list count for more', () => {
    // b is first in the keyword list only; a is first in the meaning list only.
    assert.equal(rrf([['b'], ['a']])[0].id, 'b', 'equal weights: list order breaks the tie');
    assert.equal(rrf([['b'], ['a']], 60, [1, 1.5])[0].id, 'a');
    assert.ok(Math.abs(rrf([['b'], ['a']], 60, [1, 1.5])[0].score - 1.5 / 61) < 1e-12);
  });

  it('RANK-05 keyword hits must cover a fair share of the question', () => {
    const q = 'what to do when a remote service keeps timing out';
    // Content words: remote, service, timing ("keeps", "out" and the rest are stopwords).
    assert.deepEqual(termCoverage(q, 'Readiness probe removes the pod from the service'), { matched: 1, share: 1 / 3 });
    assert.equal(isStrongKeywordHit(q, 'Readiness probe removes the pod from the service'), false, 'one incidental word');
    assert.equal(isStrongKeywordHit('exponential backoff jitter', 'Use exponential backoff with jitter'), true);
    assert.equal(isStrongKeywordHit('readiness probe', 'Liveness and readiness probes'), true, 'plurals match');
    assert.equal(isStrongKeywordHit('sourdough', 'Sourdough starter'), true, 'single-word queries still count');
  });

  it('RANK-03 reciprocal-rank fusion favours items found by both lists', () => {
    const fused = rrf([['a', 'b', 'c'], ['c', 'd', 'a']]);
    assert.deepEqual(fused.map((f) => f.id).slice(0, 2).sort(), ['a', 'c']);
    assert.deepEqual(fused.find((f) => f.id === 'b')!.lists, [0]);
    assert.deepEqual(fused.find((f) => f.id === 'c')!.lists, [0, 1]);
    assert.ok(Math.abs(fused.find((f) => f.id === 'a')!.score - (1 / 61 + 1 / 63)) < 1e-12);
  });
});

describe('follow-up detection (ask retrieval)', () => {
  it('ASKR-01 questions that lean on earlier context are follow-ups; self-contained ones are not', () => {
    for (const q of ['And how much does it cost?', 'what about the second one', 'Why?', 'How long does that take?', 'Is it safe?', 'Do they need feeding?'])
      assert.equal(looksLikeFollowUp(q), true, q);
    for (const q of ['volcanic eruptions in Iceland', 'How often should I feed the sourdough starter?', 'What is box breathing', 'Summarise my quarterly report figures for revenue and churn in detail please now'])
      assert.equal(looksLikeFollowUp(q), false, q);
  });
});

describe('queue and providers', () => {
  it('JOB-01 retry delays grow exponentially', () => {
    assert.deepEqual([1, 2, 3].map(retryDelayMs), [10_000, 20_000, 40_000]);
  });

  it('EMB-01 the fake provider is deterministic, unit-length and word-sensitive', async () => {
    const c = new AbortController().signal;
    const [a, a2, related, other] = await fakeProvider.embed(['retry backoff network', 'retry backoff network', 'network retries', 'quarterly revenue'], c);
    assert.deepEqual(a, a2);
    assert.ok(Math.abs(Math.hypot(...a) - 1) < 1e-9);
    assert.equal(a.length, fakeProvider.dims);
    assert.ok(cosine(a, related) > cosine(a, other));
  });
});
