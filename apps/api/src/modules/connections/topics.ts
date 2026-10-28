import { organizeSettings } from '../organize/organize.service';
import { terms } from '../search/rank';
import type { LibNote, Library } from './graph';

/** Mutable only so the eval can sweep them; the sweeps are in docs/eval/phase6.md. */
export const topicSettings = {
  /** Notes at least this similar can end up in the same topic (the same bar as a "similar" line in
   *  the graph). 0.40 recovered 90% of the eval's known subjects (0.45: 86%, 0.50: 58%) and grouped
   *  more notes; at 0.45 real 4-note topics (running at 0.446) often fell apart into pairs. */
  topicMin: 0.4,
  /** Linked notes need only this similarity to share a topic… */
  linkedMin: 0.3,
  /** …and their connection counts this much stronger. */
  linkBonus: 0.15,
  /** Two groups that are already topics only merge through a connection at least this strong,
   *  so one borderline note can't bridge two clear topics (in the demo library, "Load testing
   *  with k6" at 0.40 joined the running and Kubernetes topics into one). */
  mergeMin: 0.5,
  /** Topics stop growing at this size, so one loose chain can't swallow the library. */
  maxSize: 40,
  /** Smaller groups aren't called a topic. */
  minSize: 3,
};

export type Topic = { id: string; name: string; noteIds: string[] };
export type Topics = { topics: Topic[]; unconnected: LibNote[] };

/**
 * Connections that may join a topic, strongest first. A [[link]] lowers the bar to `linkedMin`
 * and counts a little stronger, but never joins notes with nothing in common: otherwise one hub
 * note linking to everything (a weekend plan, an index) would merge unrelated topics.
 */
function topicEdges(lib: Library, s: typeof topicSettings) {
  const linked = new Set<string>();
  lib.notes.forEach((n, i) => {
    for (const target of n.linksTo) {
      const j = lib.index.get(target);
      if (j !== undefined && j !== i) linked.add(i < j ? `${i}:${j}` : `${j}:${i}`);
    }
  });
  return lib.pairs
    .map((p) => (linked.has(`${p.i}:${p.j}`) ? { ...p, w: p.score + s.linkBonus, min: s.linkedMin } : { ...p, w: p.score, min: s.topicMin }))
    .filter((p) => p.score >= p.min)
    .sort((a, b) => b.w - a.w);
}

/**
 * The most common tag if at least half the notes share it; otherwise up to two shared title words
 * most typical of this group compared with the whole library; otherwise its first note's title.
 */
export function topicName(members: LibNote[], all: LibNote[]): string {
  const tagCount = new Map<string, number>();
  for (const n of members) for (const t of n.tags) tagCount.set(t, (tagCount.get(t) ?? 0) + 1);
  const [tag, count] = [...tagCount].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? [];
  if (tag && count! * 2 >= members.length) return tag;

  const df = new Map<string, number>();
  for (const n of all) for (const w of terms(n.title)) df.set(w, (df.get(w) ?? 0) + 1);
  const tf = new Map<string, number>();
  for (const n of members) for (const w of terms(n.title)) tf.set(w, (tf.get(w) ?? 0) + 1);
  // A name word must be shared: by at least 2 notes and a third of the topic.
  const minShare = Math.max(2, Math.ceil(members.length / 3));
  const words = [...tf]
    .filter(([, c]) => c >= minShare)
    .map(([w, c]) => ({ w, score: c * Math.log((all.length + 1) / (df.get(w) ?? 1)) }))
    .sort((a, b) => b.score - a.score || a.w.localeCompare(b.w))
    .slice(0, 2)
    .map((x) => x.w);
  return words.length ? words.join(' · ') : members[0].title;
}

/**
 * Groups notes into topics: connections are added strongest first (see topicEdges), joining two
 * groups only while the result stays within the size limit, and joining two existing topics only
 * through a strong connection (single-linkage clustering with a size cap and a merge bar).
 * Groups smaller than `minSize` aren't topics. Also lists notes with no link and nothing similar.
 */
export function computeTopics(lib: Library, s = topicSettings): Topics {
  const parent = lib.notes.map((_, i) => i);
  const size = lib.notes.map(() => 1);
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const { i, j, w } of topicEdges(lib, s)) {
    const [a, b] = [find(i), find(j)];
    if (a === b || size[a] + size[b] > s.maxSize) continue;
    if (size[a] >= s.minSize && size[b] >= s.minSize && w < s.mergeMin) continue;
    const [big, small] = size[a] >= size[b] ? [a, b] : [b, a];
    parent[small] = big;
    size[big] += size[small];
  }

  const groups = new Map<number, number[]>();
  lib.notes.forEach((_, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), i]));
  const topics = [...groups.values()]
    .filter((g) => g.length >= s.minSize)
    .sort((a, b) => b.length - a.length)
    .map((g) => {
      const ids = g.map((i) => lib.notes[i].id);
      return { id: `t-${[...ids].sort()[0]}`, name: topicName(g.map((i) => lib.notes[i]), lib.notes), noteIds: ids };
    });

  const connected = new Set<number>();
  for (const p of lib.pairs) if (p.score >= organizeSettings.relatedMin) connected.add(p.i).add(p.j);
  lib.notes.forEach((n, i) => {
    for (const target of n.linksTo) {
      const j = lib.index.get(target);
      if (j !== undefined && j !== i) connected.add(i).add(j);
    }
  });
  return { topics, unconnected: lib.notes.filter((_, i) => !connected.has(i)) };
}

const cache = new WeakMap<Library, Topics>();
/** Topics for a library, computed once per library version. */
export function topicsFor(lib: Library): Topics {
  let t = cache.get(lib);
  if (!t) cache.set(lib, (t = computeTopics(lib)));
  return t;
}
