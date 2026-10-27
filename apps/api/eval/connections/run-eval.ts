/**
 * Connections evaluation (Phase 6), free: local embedding model, no API key.
 * Loads the Phase 3 dataset (40 notes) plus the Phase 5 extra sets (4 dense topics of 4 notes,
 * 8 near-copies) into a throwaway database, then measures:
 *   - similarity connections in the graph: how many per note, and how often they join notes on
 *     the same subject vs unrelated ones (threshold sweep)
 *   - topics: how well automatic groups recover known subjects, coverage, and their names
 *     (threshold sweep)
 * and writes docs/eval/phase6.md.
 *
 *   npm run eval:connections -w apps/api
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoMemoryServer } from 'mongodb-memory-server';

type Item = { id: string; type: string; title: string; content: string; tags: string[] };
type Extra = {
  folders: Record<string, string[]>;
  denseTopics: { folder: string; tags: string[]; notes: { title: string; content: string }[] }[];
  nearDuplicates: { of: string; title: string; content: string }[];
};

const here = path.dirname(fileURLToPath(import.meta.url));
const dataset: Item[] = JSON.parse(readFileSync(path.join(here, '../search/dataset.json'), 'utf8'));
const extra: Extra = JSON.parse(readFileSync(path.join(here, '../organize/extra.json'), 'utf8'));
const outFile = path.resolve(here, '../../../../docs/eval/phase6.md');

const SIMILAR_MINS = [0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const TOPIC_MINS = [0.4, 0.45, 0.5, 0.55, 0.6, 0.65];

/** Known subjects: each dense topic plus the dataset note on the same subject. */
const SUBJECTS: Record<string, { dense: string; dataset: string; broad: string }> = {
  baking: { dense: 'Kitchen', dataset: 'n26', broad: 'Personal' },
  running: { dense: 'Training', dataset: 'n29', broad: 'Personal' },
  kubernetes: { dense: 'Platform', dataset: 'n07', broad: 'Engineering' },
  money: { dense: 'Money', dataset: 'n28', broad: 'Personal' },
};
const broadOf = (tags: string[]) => Object.entries(extra.folders).find(([, ts]) => tags.some((t) => ts.includes(t)))?.[0] ?? null;

async function main() {
  const mongo = await MongoMemoryServer.create();
  Object.assign(process.env, {
    NODE_ENV: 'test',
    MONGODB_URI: mongo.getUri('mindmesh_eval_connections'),
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
  const graph = await import('../../src/modules/connections/graph.js');
  const topics = await import('../../src/modules/connections/topics.js');
  const { embeddingProvider } = await import('../../src/platform/ai-client.js');
  await connectDb();

  const userId = new mongoose.Types.ObjectId().toString();
  const make = (title: string, content: string, tags: string[], type = 'note') =>
    createNote(userId, { type: type as never, title, content, tags, folderId: null, sourceUrl: null, metadata: {}, pinned: false, archived: false });

  // Ground truth per note: subject (fine, may be missing), copy group, tags, broad folder.
  type Truth = { subject: string | null; group: string; tags: string[]; broad: string | null; title: string };
  const truth = new Map<string, Truth>();
  const subjectOfDataset = new Map(Object.entries(SUBJECTS).map(([s, v]) => [v.dataset, s]));
  for (const it of dataset) {
    const n = await make(it.title, it.content, it.tags, it.type);
    truth.set(String(n._id), { subject: subjectOfDataset.get(it.id) ?? null, group: it.id, tags: it.tags, broad: broadOf(it.tags), title: it.title });
  }
  for (const d of extra.nearDuplicates) {
    const orig = dataset.find((x) => x.id === d.of)!;
    const n = await make(d.title, d.content, []);
    truth.set(String(n._id), { subject: subjectOfDataset.get(d.of) ?? null, group: d.of, tags: orig.tags, broad: broadOf(orig.tags), title: d.title });
  }
  for (const t of extra.denseTopics) {
    const [subject, s] = Object.entries(SUBJECTS).find(([, v]) => v.dense === t.folder)!;
    for (const n of t.notes) {
      const created = await make(n.title, n.content, t.tags);
      truth.set(String(created._id), { subject, group: `dense-${subject}-${n.title}`, tags: t.tags, broad: s.broad, title: n.title });
    }
  }
  await drain();
  const lib = await graph.loadLibrary(userId);
  const all = new Set(lib.notes.map((_, i) => i));
  const T = (i: number) => truth.get(lib.notes[i].id)!;
  const subjectNotes = [...truth.values()].filter((t) => t.subject).length;

  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const lines: string[] = ['# Phase 6 connections evaluation', ''];
  lines.push(`Generated by \`npm run eval:connections -w apps/api\` on ${new Date().toISOString().slice(0, 10)}. Free: local model \`${embeddingProvider().model}\`, no API key.`, '');
  lines.push(`- ${lib.notes.length} notes: the ${dataset.length}-note Phase 3 dataset, ${extra.nearDuplicates.length} reworded copies of dataset notes, and ${extra.denseTopics.length} topics of ${extra.denseTopics[0].notes.length} notes each (from the Phase 5 eval).`);
  lines.push(`- **Known subjects:** ${Object.entries(SUBJECTS).map(([s, v]) => `*${s}* (the ${v.dense} notes + "${dataset.find((x) => x.id === v.dataset)!.title}")`).join(', ')}; and each copy with its original. ${subjectNotes} notes belong to a known subject.`);
  lines.push('- A connection is **on topic** when both notes share a known subject, are a copy and its original, or share a tag; **loosely related** when they are only in the same broad area (Engineering, Work or Personal); **unrelated** otherwise.', '');

  // --- Similarity connections ---------------------------------------------------------------
  const judge = (i: number, j: number) => {
    const [a, b] = [T(i), T(j)];
    if ((a.subject && a.subject === b.subject) || a.group === b.group || a.tags.some((t) => b.tags.includes(t))) return 'on';
    return a.broad && a.broad === b.broad ? 'loose' : 'off';
  };
  const edgeStats = (min: number) => {
    const edges = graph.similarityEdges(lib, all, min, graph.graphSettings.similarPerNote);
    const kinds = { on: 0, loose: 0, off: 0 };
    const degree = new Map<number, number>();
    const subjectHit = new Set<number>();
    for (const e of edges) {
      const k = judge(e.i, e.j);
      kinds[k]++;
      for (const x of [e.i, e.j]) degree.set(x, (degree.get(x) ?? 0) + 1);
      if (T(e.i).subject && T(e.i).subject === T(e.j).subject) subjectHit.add(e.i).add(e.j);
    }
    const n = edges.length || 1;
    return {
      edges, perNote: (2 * edges.length) / lib.notes.length, isolated: lib.notes.filter((_, i) => !degree.has(i)).length / lib.notes.length,
      on: kinds.on / n, loose: kinds.loose / n, off: kinds.off / n, subjectRecall: subjectHit.size / subjectNotes,
    };
  };
  const chosenSimilar = graph.graphSettings.similarMin;
  const sim = edgeStats(chosenSimilar);
  lines.push('## Similarity connections in the graph', '');
  lines.push(`Each note keeps its ${graph.graphSettings.similarPerNote} most similar notes above the threshold (chosen: **${chosenSimilar}**).`, '');
  lines.push('| Metric | Result |', '|---|---|');
  lines.push(`| On topic | ${pct(sim.on)} |`, `| Loosely related | ${pct(sim.loose)} |`, `| Unrelated | ${pct(sim.off)} |`);
  lines.push(`| Connections per note | ${sim.perNote.toFixed(1)} |`, `| Notes with no similar connection | ${pct(sim.isolated)} |`);
  lines.push(`| Known-subject notes connected to their subject | ${pct(sim.subjectRecall)} |`, '');
  lines.push('### Sweep: minimum similarity', '');
  lines.push('| Value | On topic | Loosely related | Unrelated | Per note | Unconnected | Subject notes connected |', '|---|---|---|---|---|---|---|');
  for (const v of SIMILAR_MINS) {
    const s = edgeStats(v);
    lines.push(`| ${v.toFixed(2)}${v === chosenSimilar ? ' **(chosen)**' : ''} | ${pct(s.on)} | ${pct(s.loose)} | ${pct(s.off)} | ${s.perNote.toFixed(1)} | ${pct(s.isolated)} | ${pct(s.subjectRecall)} |`);
  }
  const offEdges = sim.edges.filter((e) => judge(e.i, e.j) === 'off');
  if (offEdges.length) {
    lines.push('', 'Unrelated connections at the chosen value:', '');
    for (const e of offEdges) lines.push(`- *${T(e.i).title}* and *${T(e.j).title}* (${pct(e.score)})`);
  }

  // --- Topics -------------------------------------------------------------------------------
  const topicStats = (topicMin: number) => {
    const t = topics.computeTopics(lib, { ...topics.topicSettings, topicMin });
    const idx = (id: string) => lib.index.get(id)!;
    // Subject recovery: for each known subject, the topic holding most of its notes (F1).
    const f1s = Object.keys(SUBJECTS).map((subject) => {
      const members = new Set([...lib.notes.keys()].filter((i) => T(i).subject === subject));
      let best = 0;
      for (const tp of t.topics) {
        const hit = tp.noteIds.filter((id) => members.has(idx(id))).length;
        if (!hit) continue;
        const p = hit / tp.noteIds.length;
        const r = hit / members.size;
        best = Math.max(best, (2 * p * r) / (p + r));
      }
      return { subject, f1: best };
    });
    // Purity: share of each topic's notes in its most common broad area.
    let pure = 0;
    for (const tp of t.topics) {
      const c = new Map<string, number>();
      for (const id of tp.noteIds) {
        const b = T(idx(id)).broad ?? '?';
        c.set(b, (c.get(b) ?? 0) + 1);
      }
      pure += Math.max(...c.values());
    }
    const inTopic = t.topics.reduce((n, tp) => n + tp.noteIds.length, 0);
    return { t, f1s, f1: f1s.reduce((n, x) => n + x.f1, 0) / f1s.length, purity: inTopic ? pure / inTopic : 1, coverage: inTopic / lib.notes.length };
  };
  const chosenTopic = topics.topicSettings.topicMin;
  const tp = topicStats(chosenTopic);
  lines.push('', '## Topics', '');
  lines.push(`Notes at least **${chosenTopic}** similar (or linked) are grouped, strongest connections first, up to ${topics.topicSettings.maxSize} notes per topic; groups under ${topics.topicSettings.minSize} notes aren't topics.`, '');
  lines.push('| Metric | Result |', '|---|---|');
  lines.push(`| Known subjects recovered (average best-topic F1) | ${pct(tp.f1)} |`);
  lines.push(`| Purity: notes in their topic's main broad area | ${pct(tp.purity)} |`);
  lines.push(`| Notes in a topic | ${pct(tp.coverage)} |`, `| Topics | ${tp.t.topics.length} |`, `| Unconnected notes | ${tp.t.unconnected.length} |`, '');
  lines.push(`Per subject: ${tp.f1s.map((x) => `${x.subject} ${pct(x.f1)}`).join(' · ')}`, '');
  lines.push('### Sweep: minimum similarity for a topic', '');
  lines.push('| Value | Subjects recovered | Purity | Notes in a topic | Topics |', '|---|---|---|---|---|');
  for (const v of TOPIC_MINS) {
    const s = topicStats(v);
    lines.push(`| ${v.toFixed(2)}${v === chosenTopic ? ' **(chosen)**' : ''} | ${pct(s.f1)} | ${pct(s.purity)} | ${pct(s.coverage)} | ${s.t.topics.length} |`);
  }
  lines.push('', '### Topics found at the chosen value', '', '| Name | Notes |', '|---|---|');
  for (const x of tp.t.topics) lines.push(`| ${x.name} | ${x.noteIds.map((id) => T(lib.index.get(id)!).title).join(' · ')} |`);
  lines.push('', `Unconnected notes: ${tp.t.unconnected.map((n) => n.title).join(' · ') || 'none'}.`);

  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, lines.join('\n') + '\n');
  console.log(lines.join('\n'));
  await mongoose.disconnect();
  await mongo.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
