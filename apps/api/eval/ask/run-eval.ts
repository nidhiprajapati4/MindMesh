/**
 * Answer-quality evaluation (Phase 4). Runs questions.json through the real Ask pipeline
 * (retrieval → answer → citations) over the Phase 3 dataset and writes docs/eval/phase4.md.
 *
 * Scores, with no LLM judge:
 *   - retrieval: the expected note was among the sources handed to the model
 *   - citation accuracy: the answer cites the expected note
 *   - fact coverage: the key facts appear in the answer text
 *   - abstention: unanswerable questions are declined, answerable ones are not
 *
 *   npm run eval:ask -w apps/api            # free smart quotes, with tuning sweeps
 *   npm run eval:ask -w apps/api -- --paid  # Claude via ANTHROPIC_API_KEY (costs about $0.60)
 *   npm run eval:ask -w apps/api -- --fake  # test answerer (checks the harness only)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';

type Item = { id: string; type: string; title: string; content: string; tags: string[] };
type Question = { id: string; question: string; expected: string | null; facts: string[][]; note?: string };

const here = path.dirname(fileURLToPath(import.meta.url));
const dataset: Item[] = JSON.parse(readFileSync(path.join(here, '../search/dataset.json'), 'utf8'));
const questions: Question[] = JSON.parse(readFileSync(path.join(here, 'questions.json'), 'utf8'));
const outFile = path.resolve(here, '../../../../docs/eval/phase4.md');

/** How a declining answer reads; matched against the answer text. */
const DECLINE = /couldn'?t find|could not find|not (?:in|mentioned in|covered (?:in|by)|found in) (?:your|the) notes|notes (?:don'?t|do not) (?:contain|mention|say|cover|include)|no information|isn'?t (?:in|mentioned)|don'?t (?:have|see) (?:any )?information/i;

const QUOTE_THRESHOLDS = [0.25, 0.3, 0.35, 0.4, 0.45, 0.5];
const QUOTE_GAPS = [Infinity, 0.2, 0.15, 0.1, 0.05];
const SAME_NOTE_MINS = [0.1, 0.15, 0.2, 0.25, 0.35];

async function main() {
  const paid = process.argv.includes('--paid');
  if (paid && !process.env.ANTHROPIC_API_KEY) throw new Error('--paid needs ANTHROPIC_API_KEY (set it in apps/api/.env)');
  const mode = paid ? 'anthropic' : process.argv.includes('--fake') ? 'fake' : 'quotes';

  const mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: mongo.getUri('mindmesh_eval_ask'),
    FIREBASE_PROJECT_ID: 'demo-eval',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9',
    VECTOR_BACKEND: 'memory',
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER ?? 'local',
    ANSWER_PROVIDER: mode,
    AI_DAILY_TOKEN_BUDGET: '100000000',
  });
  const mongoose = (await import('mongoose')).default;
  const { connectDb } = await import('../../src/config/db.js');
  const { createNote } = await import('../../src/modules/notes/notes.service.js');
  const { drain } = await import('../../src/modules/ai-processing/pipeline.js');
  const { prepareAsk, runAsk } = await import('../../src/modules/ask/ask.service.js');
  const { answerProvider, embeddingProvider } = await import('../../src/platform/ai-client.js');
  await connectDb();

  const userId = new mongoose.Types.ObjectId().toString();
  const idOf = new Map<string, string>(); // mongo id -> dataset id
  for (const it of dataset) {
    const note = await createNote(userId, { type: it.type as never, title: it.title, content: it.content, tags: it.tags, folderId: null, sourceUrl: null, metadata: {}, pinned: false, archived: false });
    idOf.set(String(note._id), it.id);
  }
  await drain();

  type Row = {
    q: Question; sources: string[]; cited: string[]; answer: string; status: string;
    retrieved: boolean; citedOk: boolean; precision: number; facts: number; declined: boolean; ms: number; tokensIn: number; tokensOut: number; cost: number;
  };
  const runAll = async (): Promise<Row[]> => {
  const rows: Row[] = [];
  for (const q of questions) {
    const started = Date.now();
    let sources: { noteId: string }[] = [];
    let done: any = null;
    let answer = '';
    const prepared = await prepareAsk(userId, { question: q.question });
    await runAsk(userId, { question: q.question }, prepared, (event, data: any) => {
      if (event === 'start') sources = data.sources;
      if (event === 'text') answer += data.text;
      if (event === 'done') done = data;
    }, new AbortController().signal);

    const turn = done.turn;
    const sourceIds = sources.map((s) => idOf.get(s.noteId) ?? '?');
    const cited = [...new Set<string>(turn.segments.flatMap((s: any) => s.citations.map((c: any) => sourceIds[c.source])))];
    const lower = answer.toLowerCase();
    const factHits = q.facts.filter((alts) => alts.some((a) => lower.includes(a.toLowerCase()))).length;
    rows.push({
      q, sources: sourceIds, cited, answer, status: turn.status,
      retrieved: !!q.expected && sourceIds.includes(q.expected),
      citedOk: !!q.expected && cited.includes(q.expected),
      // Share of the notes cited that are the right one (extra citations to other notes lower it).
      precision: q.expected && cited.length ? (cited.includes(q.expected) ? 1 : 0) / cited.length : 0,
      facts: q.facts.length ? factHits / q.facts.length : 1,
      declined: turn.status === 'not_found' || DECLINE.test(answer),
      ms: Date.now() - started, tokensIn: turn.inputTokens, tokensOut: turn.outputTokens, cost: turn.costUsd,
    });
    process.stdout.write('.');
  }
  return rows;
  };

  const share = (xs: Row[], f: (r: Row) => boolean | number) => xs.reduce((s, r) => s + Number(f(r)), 0) / (xs.length || 1);
  const pct = (x: number) => `${Math.round(x * 100)}%`;

  // Smart quotes: sweep its two settings, one at a time, around the configured values.
  const { quoteSettings } = await import('../../src/platform/generation/quotes.js');
  const chosen = { ...quoteSettings };
  type SweepRow = { label: string; chosen: boolean; citedOk: number; precision: number; facts: number; answered: number; declined: number };
  const sweeps: { title: string; about: string; rows: SweepRow[] }[] = [];
  const sweep = async (key: 'minSimilarity' | 'maxGapFromBest' | 'sameNoteMinSimilarity', values: number[]) => {
    const out: SweepRow[] = [];
    for (const v of values) {
      Object.assign(quoteSettings, chosen, { [key]: v });
      const r = await runAll();
      const a = r.filter((x) => x.q.expected);
      const u = r.filter((x) => !x.q.expected);
      out.push({
        label: Number.isFinite(v) ? v.toFixed(2) : 'no limit', chosen: v === chosen[key],
        citedOk: share(a, (x) => x.citedOk), precision: share(a, (x) => x.precision), facts: share(a, (x) => x.facts),
        answered: share(a, (x) => !x.declined), declined: share(u, (x) => x.declined),
      });
    }
    Object.assign(quoteSettings, chosen);
    return out;
  };
  if (mode === 'quotes') {
    sweeps.push({ title: 'Minimum similarity', about: 'A sentence is quoted only if it is at least this close to the question. Higher declines more often.', rows: await sweep('minSimilarity', QUOTE_THRESHOLDS) });
    sweeps.push({ title: 'Gap from the best quote', about: 'Quotes from other notes must score within this much of the best one. Smaller keeps only near-equal quotes, so fewer loosely related sentences from other notes.', rows: await sweep('maxGapFromBest', QUOTE_GAPS) });
    sweeps.push({ title: 'Second sentence from the best note', about: 'How relevant a second sentence from the best-matching note must be. Lower adds more context from that note.', rows: await sweep('sameNoteMinSimilarity', SAME_NOTE_MINS) });
  }
  const rows = await runAll();
  console.log();

  const answerable = rows.filter((r) => r.q.expected);
  const unanswerable = rows.filter((r) => !r.q.expected);
  const total = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const ap = answerProvider();
  const ep = embeddingProvider();
  const title = (id: string | null) => (id && dataset.find((d) => d.id === id)?.title) || '—';
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 160);

  const lines: string[] = [];
  lines.push('# Phase 4 answer evaluation', '');
  lines.push(`Generated by \`npm run eval:ask -w apps/api${paid ? ' -- --paid' : mode === 'fake' ? ' -- --fake' : ''}\` on ${new Date().toISOString().slice(0, 10)}.`, '');
  if (mode === 'fake') lines.push('> **Fake answerer: this run checks the harness only.** Its fact coverage and abstention say nothing about real answers.', '');
  if (mode === 'quotes') lines.push('> **Smart quotes (free mode):** answers are the sentences from the retrieved notes closest in meaning to the question, each cited. No language model is used, so it can quote but not summarise.', '');
  lines.push(`- Answer model: \`${ap.name}\` / \`${ap.model}\`. Retrieval: \`${ep.name}\` / \`${ep.model}\`, threshold and pipeline as in production.`);
  lines.push(`- ${answerable.length} answerable questions (expected note + key facts) and ${unanswerable.length} unanswerable ones (the right reply is "not in your notes"); two of those have a related note that doesn't contain the answer.`);
  lines.push(`- Total cost ${'$'}${total((r) => r.cost).toFixed(3)} (${'$'}${(total((r) => r.cost) / rows.length).toFixed(4)} per question), ${total((r) => r.tokensIn)} input / ${total((r) => r.tokensOut)} output tokens. Median time per answer ${median(rows.map((r) => r.ms))} ms.`, '');

  lines.push('## Results', '');
  lines.push('| Metric | Result |', '|---|---|');
  lines.push(`| Retrieval: expected note among the sources | ${pct(share(answerable, (r) => r.retrieved))} |`);
  lines.push(`| Citation accuracy: answer cites the expected note | ${pct(share(answerable, (r) => r.citedOk))} |`);
  lines.push(`| Citation precision: share of cited notes that are the right one | ${pct(share(answerable, (r) => r.precision))} |`);
  lines.push(`| Fact coverage: key facts present in the answer | ${pct(share(answerable, (r) => r.facts))} |`);
  lines.push(`| Answered (not declined) when the notes cover it | ${pct(share(answerable, (r) => !r.declined))} |`);
  lines.push(`| Declined when the notes don't cover it | ${pct(share(unanswerable, (r) => r.declined))} |`);
  lines.push(`| Unanswerable questions that reached the answer step (retrieval found a related note) | ${unanswerable.filter((r) => r.status !== 'not_found').length} / ${unanswerable.length} |`);

  for (const s of sweeps) {
    lines.push('', `## Smart quotes tuning: ${s.title}`, '', s.about, '');
    lines.push('| Value | Cites expected note | Citation precision | Fact coverage | Answered when covered | Declined when not covered |', '|---|---|---|---|---|---|');
    for (const r of s.rows) {
      lines.push(`| ${r.label}${r.chosen ? ' **(chosen)**' : ''} | ${pct(r.citedOk)} | ${pct(r.precision)} | ${pct(r.facts)} | ${pct(r.answered)} | ${pct(r.declined)} |`);
    }
  }

  lines.push('', '## Per question', '');
  lines.push('| ID | Question | Expected | Sources | Cited | Facts | Declined | Answer |', '|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    lines.push(`| ${r.q.id} | ${cell(r.q.question)} | ${title(r.q.expected)} | ${r.sources.length} | ${r.cited.map(title).join(', ') || '—'} | ${r.q.facts.length ? pct(r.facts) : '—'} | ${r.declined ? 'yes' : 'no'} | ${cell(r.answer)} |`);
  }

  const failures = rows.filter((r) => (r.q.expected ? !r.citedOk || r.facts < 1 || r.declined : !r.declined));
  lines.push('', '## Failures', '');
  if (!failures.length) lines.push('None.');
  for (const r of failures) {
    const why = r.q.expected
      ? [!r.retrieved && 'expected note not retrieved', r.retrieved && !r.citedOk && 'expected note not cited', r.facts < 1 && `facts ${pct(r.facts)}`, r.declined && 'declined'].filter(Boolean).join('; ')
      : 'answered instead of declining';
    lines.push(`- **${r.q.id}** "${r.q.question}": ${why}.${r.q.note ? ` (${r.q.note})` : ''}`);
  }

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(lines.slice(lines.indexOf('## Results'), lines.indexOf('## Per question')).join('\n'));
  if (process.argv.includes('--show-answers')) for (const r of rows) console.log(`${r.q.id}: ${r.answer.replace(/\n/g, ' | ')}`);
  console.log(`Failures: ${failures.map((r) => r.q.id).join(', ') || 'none'}`);
  console.log(`Wrote ${outFile}`);
  await mongoose.disconnect();
  await mongo.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
