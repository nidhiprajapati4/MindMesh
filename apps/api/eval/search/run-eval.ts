/**
 * Search evaluation (H2): recall@5 and MRR for keyword vs semantic vs hybrid search, plus a
 * sweep of the meaning-match threshold (recall vs. noise on off-topic queries).
 * Loads dataset.json into a throwaway in-memory MongoDB, embeds it with the configured provider,
 * runs every query in queries.json, and writes docs/eval/phase3.md.
 *
 *   npm run eval:search -w apps/api                      # local model (default)
 *   EMBEDDING_PROVIDER=openai OPENAI_API_KEY=… npm run eval:search -w apps/api
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';

type Item = { id: string; type: string; title: string; content: string; tags: string[] };
type Query = { id: string; kind: 'keyword' | 'paraphrase' | 'offtopic'; query: string; expected: string | null };
type Mode = 'keyword' | 'semantic' | 'hybrid';
const MODES: Mode[] = ['keyword', 'semantic', 'hybrid'];
const DEPTH = 10; // ranks beyond this count as "not found"
const SWEEP = [0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
const HYBRID_WEIGHTS = [1, 1.5, 2, 3, 5];

const here = path.dirname(fileURLToPath(import.meta.url));
const dataset: Item[] = JSON.parse(readFileSync(path.join(here, 'dataset.json'), 'utf8'));
const queries: Query[] = JSON.parse(readFileSync(path.join(here, 'queries.json'), 'utf8'));
const outFile = path.resolve(here, '../../../../docs/eval/phase3.md');

async function main() {
  const mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: mongo.getUri('mindmesh_eval'),
    FIREBASE_PROJECT_ID: 'demo-eval',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9',
    VECTOR_BACKEND: 'memory',
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER ?? 'local',
    AI_DAILY_TOKEN_BUDGET: '100000000',
  });
  const mongoose = (await import('mongoose')).default;
  const { connectDb } = await import('../../src/config/db.js');
  const { createNote } = await import('../../src/modules/notes/notes.service.js');
  const { drain } = await import('../../src/modules/ai-processing/pipeline.js');
  const { search, MIN_SIMILARITY } = await import('../../src/modules/search/search.service.js');
  const { nearestChunks } = await import('../../src/modules/search/vector-store.js');
  const { embed, embeddingProvider } = await import('../../src/platform/ai-client.js');
  await connectDb();

  const userId = new mongoose.Types.ObjectId().toString();
  const idOf = new Map<string, string>(); // mongo id -> dataset id
  for (const it of dataset) {
    const note = await createNote(userId, { type: it.type as never, title: it.title, content: it.content, tags: it.tags, folderId: null, sourceUrl: null, metadata: {}, pinned: false, archived: false });
    idOf.set(String(note._id), it.id);
  }
  const started = Date.now();
  const outcomes = await drain();
  const indexMs = Date.now() - started;
  if (outcomes.some((o) => o !== 'ready')) throw new Error(`Indexing did not finish cleanly: ${outcomes.join(', ')}`);

  const provider = embeddingProvider();
  const threshold = MIN_SIMILARITY[provider.name] ?? 0.3;
  const positives = queries.filter((q) => q.expected);
  const offtopic = queries.filter((q) => !q.expected);

  // 1. End-to-end search, exactly as the API runs it.
  type Row = { q: Query; rank: Record<Mode, number | null>; top: Record<Mode, string[]>; count: Record<Mode, number> };
  const rows: Row[] = [];
  const latency: Record<Mode, number[]> = { keyword: [], semantic: [], hybrid: [] };
  for (const q of queries) {
    const row = { q, rank: {}, top: {}, count: {} } as Row;
    for (const mode of MODES) {
      const t0 = Date.now();
      const res = await search(userId, { q: q.query, mode, limit: DEPTH });
      latency[mode].push(Date.now() - t0);
      const ids = res.items.map((h) => idOf.get(String(h.note._id)) ?? '?');
      const at = q.expected ? ids.indexOf(q.expected) : -1;
      row.rank[mode] = at >= 0 ? at + 1 : null;
      row.top[mode] = ids.slice(0, 3);
      row.count[mode] = ids.length;
    }
    rows.push(row);
  }

  // 2. Threshold sweep: raw similarity of every note to every query, best chunk per note.
  const scored = new Map<string, { id: string; score: number }[]>();
  for (const q of queries) {
    const { vectors, model } = await embed([q.query], { userId, purpose: 'query' });
    const best = new Map<string, number>();
    for (const h of await nearestChunks(userId, model, vectors[0], 1000)) {
      const id = idOf.get(h.noteId)!;
      best.set(id, Math.max(best.get(id) ?? -1, h.score));
    }
    scored.set(q.id, [...best.entries()].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score));
  }
  const sweep = SWEEP.map((t) => {
    const kept = (q: Query) => scored.get(q.id)!.filter((s) => s.score >= t);
    const hit5 = (q: Query) => kept(q).slice(0, 5).some((s) => s.id === q.expected);
    const recall = (qs: Query[]) => qs.filter(hit5).length / (qs.length || 1);
    const avg = (qs: Query[]) => qs.reduce((n, q) => n + Math.min(DEPTH, kept(q).length), 0) / (qs.length || 1);
    return {
      t,
      recallAll: recall(positives),
      recallPara: recall(positives.filter((q) => q.kind === 'paraphrase')),
      shown: avg(positives),
      noise: avg(offtopic),
      noisyQueries: offtopic.filter((q) => kept(q).length > 0).length,
    };
  });

  // 3. Hybrid weight sweep: how much should meaning results count against keyword results?
  const { hybridWeights } = await import('../../src/modules/search/search.service.js');
  const chosenWeight = hybridWeights.meaning;
  const weightSweep = [];
  for (const w of HYBRID_WEIGHTS) {
    hybridWeights.meaning = w;
    const ranks = new Map<string, number | null>();
    for (const q of positives) {
      const res = await search(userId, { q: q.query, mode: 'hybrid', limit: DEPTH });
      const at = res.items.map((h) => idOf.get(String(h.note._id))).indexOf(q.expected!);
      ranks.set(q.id, at >= 0 ? at + 1 : null);
    }
    const score = (kind: Query['kind']) => {
      const qs = positives.filter((q) => q.kind === kind);
      return {
        recall5: qs.filter((q) => (ranks.get(q.id) ?? 99) <= 5).length / qs.length,
        mrr: qs.reduce((s, q) => s + (ranks.get(q.id) ? 1 / ranks.get(q.id)! : 0), 0) / qs.length,
      };
    };
    weightSweep.push({ w, keyword: score('keyword'), paraphrase: score('paraphrase') });
  }
  hybridWeights.meaning = chosenWeight;

  // 4. Report.
  const metrics = (subset: Row[], mode: Mode) => {
    const n = subset.length || 1;
    const recall5 = subset.filter((r) => r.rank[mode] !== null && r.rank[mode]! <= 5).length / n;
    const mrr = subset.reduce((s, r) => s + (r.rank[mode] ? 1 / r.rank[mode]! : 0), 0) / n;
    return { recall5, mrr };
  };
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const pos = rows.filter((r) => r.q.expected);
  const off = rows.filter((r) => !r.q.expected);
  const groups: [string, Row[]][] = [
    [`All ${pos.length} queries`, pos],
    [`Keyword-style (${pos.filter((r) => r.q.kind === 'keyword').length})`, pos.filter((r) => r.q.kind === 'keyword')],
    [`Paraphrases (${pos.filter((r) => r.q.kind === 'paraphrase').length})`, pos.filter((r) => r.q.kind === 'paraphrase')],
  ];
  const title = (id: string | null) => (id && dataset.find((d) => d.id === id)?.title) || id || '—';

  const lines: string[] = [];
  lines.push('# Phase 3 search evaluation (H2)', '');
  lines.push(`Generated by \`npm run eval:search -w apps/api\` on ${new Date().toISOString().slice(0, 10)}.`, '');
  lines.push(`- Dataset: ${dataset.length} notes (\`apps/api/eval/search/dataset.json\`). Queries (\`queries.json\`): ${positives.filter((q) => q.kind === 'keyword').length} use words from the target note, ${positives.filter((q) => q.kind === 'paraphrase').length} are paraphrases written to avoid them, and ${offtopic.length} are off-topic (no matching note) to measure noise.`);
  lines.push(`- Embeddings: \`${provider.name}\` / \`${provider.model}\` (${provider.dims} dims), chunks of ~${provider.chunkTokens} tokens. Vector search: in-memory cosine (same ranking as Atlas). Meaning-match threshold: **${threshold}**.`);
  lines.push(`- Indexing ${dataset.length} notes took ${(indexMs / 1000).toFixed(1)} s (including model load). Median query latency: keyword ${median(latency.keyword)} ms, semantic ${median(latency.semantic)} ms, hybrid ${median(latency.hybrid)} ms.`);
  lines.push('- recall@5 = share of queries whose expected note is in the top 5. MRR = mean of 1/rank (0 if not in the top 10).', '');

  lines.push('## Results', '');
  lines.push('| Queries | Keyword recall@5 | Keyword MRR | Semantic recall@5 | Semantic MRR | Hybrid recall@5 | Hybrid MRR |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const [label, subset] of groups) {
    const m = MODES.map((mode) => metrics(subset, mode));
    lines.push(`| ${label} | ${m.map((x) => `${pct(x.recall5)} | ${x.mrr.toFixed(2)}`).join(' | ')} |`);
  }
  const avgCount = (mode: Mode) => (off.reduce((n, r) => n + r.count[mode], 0) / (off.length || 1)).toFixed(1);
  lines.push('', `Off-topic queries (should return nothing): average results per query, keyword ${avgCount('keyword')}, semantic ${avgCount('semantic')}, hybrid ${avgCount('hybrid')}.`);

  lines.push('', '## Threshold sweep (semantic)', '');
  lines.push('A meaning match counts only if its cosine similarity reaches the threshold. Lower keeps more true matches but also more noise.', '');
  lines.push('| Threshold | recall@5 (all) | recall@5 (paraphrases) | avg results, real queries | avg results, off-topic | off-topic queries with any result |');
  lines.push('|---|---|---|---|---|---|');
  for (const s of sweep) {
    const mark = Math.abs(s.t - threshold) < 1e-9 ? ' **(chosen)**' : '';
    lines.push(`| ${s.t.toFixed(2)}${mark} | ${pct(s.recallAll)} | ${pct(s.recallPara)} | ${s.shown.toFixed(1)} | ${s.noise.toFixed(1)} | ${s.noisyQueries} / ${offtopic.length} |`);
  }

  lines.push('', '## Hybrid weight sweep', '');
  lines.push('Hybrid ("Both") merges the keyword and meaning rankings with reciprocal-rank fusion. The weight is how much a meaning match counts relative to a keyword match.', '');
  lines.push('| Meaning weight | Keyword-style recall@5 | Keyword-style MRR | Paraphrase recall@5 | Paraphrase MRR |');
  lines.push('|---|---|---|---|---|');
  for (const s of weightSweep) {
    const mark = s.w === chosenWeight ? ' **(chosen)**' : '';
    lines.push(`| ${s.w}${mark} | ${pct(s.keyword.recall5)} | ${s.keyword.mrr.toFixed(2)} | ${pct(s.paraphrase.recall5)} | ${s.paraphrase.mrr.toFixed(2)} |`);
  }

  lines.push('', '## Per-query ranks', '', 'Rank of the expected note in each mode (— = not in the top 10). Off-topic rows show the number of results instead.', '');
  lines.push('| ID | Kind | Query | Expected | Keyword | Semantic | Hybrid |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const cells = r.q.expected ? MODES.map((m) => r.rank[m] ?? '—') : MODES.map((m) => `${r.count[m]} results`);
    lines.push(`| ${r.q.id} | ${r.q.kind} | ${r.q.query} | ${title(r.q.expected)} | ${cells.join(' | ')} |`);
  }
  const misses = pos.filter((r) => !(r.rank.hybrid && r.rank.hybrid <= 5));
  lines.push('', '## Failures (expected note not in hybrid top 5)', '');
  if (!misses.length) lines.push('None.');
  for (const r of misses) {
    const s = scored.get(r.q.id)!;
    const exp = s.findIndex((x) => x.id === r.q.expected);
    lines.push(
      `- **${r.q.id}** "${r.q.query}": expected *${title(r.q.expected)}* ` +
        `(similarity ${exp >= 0 ? s[exp].score.toFixed(2) : 'n/a'}, rank ${exp + 1} by meaning); ` +
        `hybrid top 3 was ${r.top.hybrid.map((id) => `*${title(id)}*`).join(', ') || 'empty'}.`
    );
  }
  const noisy = off.filter((r) => r.count.semantic > 0);
  if (noisy.length) {
    lines.push('', '## Off-topic queries that returned meaning matches', '');
    for (const r of noisy) lines.push(`- **${r.q.id}** "${r.q.query}": ${r.top.semantic.map((id) => `*${title(id)}* (${scored.get(r.q.id)!.find((s) => s.id === id)!.score.toFixed(2)})`).join(', ')}`);
  }

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, lines.join('\n') + '\n');

  const section = (start: string, end: string) => lines.slice(lines.indexOf(start), lines.indexOf(end)).join('\n');
  console.log(section('## Results', '## Threshold sweep (semantic)'));
  console.log(section('## Hybrid weight sweep', '## Per-query ranks'));
  console.log(`Misses (hybrid top 5): ${misses.map((r) => r.q.id).join(', ') || 'none'}`);
  console.log(`Wrote ${outFile}`);
  await mongoose.disconnect();
  await mongo.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
