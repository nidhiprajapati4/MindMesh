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
 *   npm run eval:ask -w apps/api            # fake answerer (free; checks the harness only)
 *   npm run eval:ask -w apps/api -- --paid  # Claude via ANTHROPIC_API_KEY (costs about $0.60)
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

async function main() {
  const paid = process.argv.includes('--paid');
  if (paid && !process.env.ANTHROPIC_API_KEY) throw new Error('--paid needs ANTHROPIC_API_KEY (set it in apps/api/.env)');

  const mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: mongo.getUri('mindmesh_eval_ask'),
    FIREBASE_PROJECT_ID: 'demo-eval',
    FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9',
    VECTOR_BACKEND: 'memory',
    EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER ?? 'local',
    ANSWER_PROVIDER: paid ? 'anthropic' : 'fake',
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
    retrieved: boolean; citedOk: boolean; facts: number; declined: boolean; ms: number; tokensIn: number; tokensOut: number; cost: number;
  };
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
      facts: q.facts.length ? factHits / q.facts.length : 1,
      declined: turn.status === 'not_found' || DECLINE.test(answer),
      ms: Date.now() - started, tokensIn: turn.inputTokens, tokensOut: turn.outputTokens, cost: turn.costUsd,
    });
    process.stdout.write('.');
  }
  console.log();

  const answerable = rows.filter((r) => r.q.expected);
  const unanswerable = rows.filter((r) => !r.q.expected);
  const share = (xs: Row[], f: (r: Row) => boolean | number) => xs.reduce((s, r) => s + Number(f(r)), 0) / (xs.length || 1);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const total = (f: (r: Row) => number) => rows.reduce((s, r) => s + f(r), 0);
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const ap = answerProvider();
  const ep = embeddingProvider();
  const title = (id: string | null) => (id && dataset.find((d) => d.id === id)?.title) || '—';
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 160);

  const lines: string[] = [];
  lines.push('# Phase 4 answer evaluation', '');
  lines.push(`Generated by \`npm run eval:ask -w apps/api${paid ? ' -- --paid' : ''}\` on ${new Date().toISOString().slice(0, 10)}.`, '');
  if (!paid) lines.push('> **Fake answerer: this run checks the harness only.** It quotes the first sentence of any note sharing a word with the question, so fact coverage and abstention say nothing about Claude. Run with `--paid` for real numbers.', '');
  lines.push(`- Answer model: \`${ap.name}\` / \`${ap.model}\`. Retrieval: \`${ep.name}\` / \`${ep.model}\`, threshold and pipeline as in production.`);
  lines.push(`- ${answerable.length} answerable questions (expected note + key facts) and ${unanswerable.length} unanswerable ones (the right reply is "not in your notes"); two of those have a related note that doesn't contain the answer.`);
  lines.push(`- Total cost ${'$'}${total((r) => r.cost).toFixed(3)} (${'$'}${(total((r) => r.cost) / rows.length).toFixed(4)} per question), ${total((r) => r.tokensIn)} input / ${total((r) => r.tokensOut)} output tokens. Median time per answer ${median(rows.map((r) => r.ms))} ms.`, '');

  lines.push('## Results', '');
  lines.push('| Metric | Result |', '|---|---|');
  lines.push(`| Retrieval: expected note among the sources | ${pct(share(answerable, (r) => r.retrieved))} |`);
  lines.push(`| Citation accuracy: answer cites the expected note | ${pct(share(answerable, (r) => r.citedOk))} |`);
  lines.push(`| Fact coverage: key facts present in the answer | ${pct(share(answerable, (r) => r.facts))} |`);
  lines.push(`| Answered (not declined) when the notes cover it | ${pct(share(answerable, (r) => !r.declined))} |`);
  lines.push(`| Declined when the notes don't cover it | ${pct(share(unanswerable, (r) => r.declined))} |`);
  lines.push(`| Unanswerable questions that cost a model call | ${unanswerable.filter((r) => r.status !== 'not_found').length} / ${unanswerable.length} |`);

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
  console.log(`Failures: ${failures.map((r) => r.q.id).join(', ') || 'none'}`);
  console.log(`Wrote ${outFile}`);
  await mongoose.disconnect();
  await mongo.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
