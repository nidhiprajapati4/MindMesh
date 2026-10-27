'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Graph } from '@/components/Graph';
import { NOTE_TYPES, api, type FolderList, type GraphData, type GraphNode, type NoteType, type TopicList } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

// Distinct, readable on white; grey for "none".
const PALETTE = ['#0F6E7A', '#C2410C', '#7C3AED', '#15803D', '#B91C1C', '#1D4ED8', '#A16207', '#BE185D', '#4D7C0F', '#0369A1', '#9333EA', '#57534E'];
const NONE = '#9AA3B2';
const TYPE_LABEL: Record<NoteType, string> = { note: 'Notes', snippet: 'Snippets', url: 'Links', idea: 'Ideas', document: 'Documents' };

type ColorBy = 'topic' | 'folder' | 'type';
type Filters = { folder: string; tag: string; type: string; similar: boolean };

/** All your notes and how they connect: [[links]] you wrote, and notes similar in meaning. */
export default function GraphPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const [filters, setFilters] = useState<Filters>({ folder: '', tag: '', type: '', similar: true });
  const [graph, setGraph] = useState<GraphData | null>(null);
  const [topics, setTopics] = useState<TopicList | null>(null);
  const [folders, setFolders] = useState<FolderList | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [colorBy, setColorBy] = useState<ColorBy>('topic');
  const [view, setView] = useState<'graph' | 'list'>('graph');
  const [search, setSearch] = useState('');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  // Phones get the list: a graph of hundreds of dots isn't usable on a small screen.
  useEffect(() => {
    if (window.matchMedia('(max-width: 639px)').matches) setView('list');
  }, []);

  useEffect(() => {
    if (!user) return;
    Promise.all([api<FolderList>('/api/folders'), api<string[]>('/api/notes/tags'), api<TopicList>('/api/connections/topics')])
      .then(([f, t, tp]) => {
        setFolders(f);
        setTags(t);
        setTopics(tp);
      })
      .catch((e) => setError(message(e, 'Could not load your notes')));
  }, [user]);

  useEffect(() => {
    if (!user) return;
    const params = new URLSearchParams({ similar: filters.similar ? '1' : '0' });
    if (filters.folder) params.set('folder', filters.folder);
    if (filters.tag) params.set('tag', filters.tag);
    if (filters.type) params.set('type', filters.type);
    let live = true;
    api<GraphData>(`/api/connections/graph?${params}`)
      .then((g) => live && setGraph(g))
      .catch((e) => live && setError(message(e, 'Could not load the graph')));
    return () => {
      live = false;
    };
  }, [user, filters]);

  const open = useCallback((id: string) => router.push(`/notes?open=${id}`), [router]);

  // Colour and legend for the chosen grouping.
  const { colorOf, legend } = useMemo(() => {
    const folderName = new Map((folders?.folders ?? []).map((f) => [f._id, f.name]));
    const topicName = new Map((topics?.topics ?? []).map((t) => [t.id, t.name]));
    const keyOf = (n: GraphNode) => (colorBy === 'topic' ? n.topicId : colorBy === 'folder' ? n.folderId : n.type);
    const labelOf = (key: string) => (colorBy === 'topic' ? topicName.get(key) : colorBy === 'folder' ? folderName.get(key) : TYPE_LABEL[key as NoteType]) ?? key;
    // Most common groups get the first colours; beyond the palette, the rest are grey.
    const counts = new Map<string, number>();
    for (const n of graph?.nodes ?? []) {
      const k = keyOf(n);
      if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const ordered = [...counts].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const color = new Map(ordered.slice(0, PALETTE.length).map((k, i) => [k, PALETTE[i]]));
    const noneLabel = colorBy === 'topic' ? 'No topic' : colorBy === 'folder' ? 'Unfiled' : 'Other';
    const items = ordered.slice(0, PALETTE.length).map((k) => ({ color: color.get(k)!, label: labelOf(k), count: counts.get(k)! }));
    const rest = (graph?.nodes.length ?? 0) - items.reduce((sum, i) => sum + i.count, 0);
    if (rest > 0) items.push({ color: NONE, label: ordered.length > PALETTE.length ? `${noneLabel} or other` : noneLabel, count: rest });
    return { colorOf: (n: GraphNode) => color.get(keyOf(n) ?? '') ?? NONE, legend: items };
  }, [graph, folders, topics, colorBy]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? (graph?.nodes ?? []).filter((n) => n.title.toLowerCase().includes(q)).slice(0, 8) : [];
  }, [search, graph]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-4 px-4 py-6">
      <Link href="/notes" className="text-sm text-accent hover:underline">← Back to notes</Link>
      <div>
        <h1 className="font-serif text-2xl font-semibold">Graph of your notes</h1>
        <p className="text-sm text-muted">
          Solid lines are links you wrote with [[Title]]; dashed lines join notes similar in meaning. Colours show {colorBy === 'topic' ? 'topics found automatically' : colorBy === 'folder' ? 'folders' : 'item types'}.
        </p>
      </div>

      {error && (
        <p role="alert" className="flex items-center justify-between rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
          <button className="underline" onClick={() => setError('')}>Dismiss</button>
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Folder</span>
          <select className="field w-auto py-1" value={filters.folder} onChange={(e) => set({ folder: e.target.value })}>
            <option value="">All folders</option>
            <option value="none">Unfiled</option>
            {folders?.folders.map((f) => <option key={f._id} value={f._id}>{f.name}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Tag</span>
          <select className="field w-auto py-1" value={filters.tag} onChange={(e) => set({ tag: e.target.value })}>
            <option value="">All tags</option>
            {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Type</span>
          <select className="field w-auto py-1" value={filters.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">All types</option>
            {NOTE_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Colour by</span>
          <select className="field w-auto py-1" value={colorBy} onChange={(e) => setColorBy(e.target.value as ColorBy)}>
            <option value="topic">Topic</option>
            <option value="folder">Folder</option>
            <option value="type">Type</option>
          </select>
        </label>
        <label className="flex items-center gap-2 pb-1.5">
          <input type="checkbox" checked={filters.similar} onChange={(e) => set({ similar: e.target.checked })} />
          Similar meaning
        </label>
        <div role="tablist" aria-label="View" className="ml-auto flex gap-1 rounded border border-line bg-paper p-1">
          {(['graph', 'list'] as const).map((v) => (
            <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)}
              className={`rounded px-3 py-1 ${view === v ? 'bg-white font-medium shadow-sm' : 'text-muted'}`}>
              {v === 'graph' ? 'Graph' : 'List'}
            </button>
          ))}
        </div>
      </div>

      {!graph ? (
        <p className="text-muted">Drawing your notes…</p>
      ) : !graph.nodes.length ? (
        <p className="text-muted">No notes match these filters.</p>
      ) : (
        <>
          {!graph.edges.length && (
            <p className="rounded bg-paper px-3 py-2 text-sm text-muted">
              No connections yet. Link notes by typing [[ in a note, or save a few notes on the same topic to see them join up.
            </p>
          )}
          {view === 'graph' ? (
            <>
              <div className="relative max-w-sm">
                <input className="field py-1 text-sm" type="search" placeholder="Find a note in the graph" value={search}
                  onChange={(e) => setSearch(e.target.value)} aria-label="Find a note in the graph" />
                {matches.length > 0 && (
                  <ul className="absolute inset-x-0 top-full z-10 mt-1 rounded border border-line bg-white py-1 text-sm shadow-lg">
                    {matches.map((n) => (
                      <li key={n.id}>
                        <button type="button" className="w-full px-3 py-1 text-left hover:bg-paper" onClick={() => { setFocusId(n.id); setSearch(''); }}>
                          {n.title}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <Graph nodes={graph.nodes} edges={graph.edges} colorOf={colorOf} focusId={focusId} onOpen={open} />
              <ul aria-label="Legend" className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {legend.map((l) => (
                  <li key={l.label} className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: l.color }} aria-hidden />
                    {l.label} <span className="text-muted">({l.count})</span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <ListView graph={graph} topics={topics} onOpen={open} />
          )}
          {graph.capped && <p className="text-xs text-muted">Showing your {graph.nodes.length} most recently updated notes of {graph.total}. Use the filters to see others.</p>}
        </>
      )}

      {!!topics?.unconnectedCount && (
        <details className="rounded border border-line bg-white px-3 py-2">
          <summary className="cursor-pointer text-sm font-medium">Unconnected notes ({topics.unconnectedCount})</summary>
          <p className="mt-1 text-xs text-muted">Not linked to anything and not similar to any other note. Worth linking, tagging, or tidying away.</p>
          <ul className="mt-2 flex flex-col gap-1">
            {topics.unconnected.map((n) => (
              <li key={n._id}>
                <Link href={`/notes?open=${n._id}`} className="text-sm hover:underline">{n.title}</Link>
              </li>
            ))}
          </ul>
          {topics.unconnectedCount > topics.unconnected.length && <p className="mt-1 text-xs text-muted">And {topics.unconnectedCount - topics.unconnected.length} more.</p>}
        </details>
      )}
    </div>
  );
}

/** The same notes and connections as text: grouped by topic, each note with what it connects to. */
function ListView({ graph, topics, onOpen }: { graph: GraphData; topics: TopicList | null; onOpen: (id: string) => void }) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const connections = new Map<string, { id: string; label: string }[]>();
  for (const e of graph.edges) {
    const label = e.kind === 'link' ? (e.similar ? `linked · ${Math.round(e.similar * 100)}% similar` : 'linked') : `${Math.round(e.similar! * 100)}% similar`;
    connections.set(e.source, [...(connections.get(e.source) ?? []), { id: e.target, label }]);
    connections.set(e.target, [...(connections.get(e.target) ?? []), { id: e.source, label }]);
  }
  const groups = (topics?.topics ?? [])
    .map((t) => ({ id: t.id, name: t.name, nodes: t.noteIds.map((id) => byId.get(id)).filter((n): n is GraphNode => !!n) }))
    .filter((g) => g.nodes.length);
  const inTopic = new Set(groups.flatMap((g) => g.nodes.map((n) => n.id)));
  const rest = graph.nodes.filter((n) => !inTopic.has(n.id));
  if (rest.length) groups.push({ id: 'none', name: 'Not in a topic', nodes: rest });

  return (
    <div className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.id} aria-labelledby={`topic-${g.id}`}>
          <h2 id={`topic-${g.id}`} className="font-serif text-lg font-semibold">
            {g.name} <span className="text-sm font-normal text-muted">({g.nodes.length})</span>
          </h2>
          <ul className="mt-1 flex flex-col gap-2">
            {g.nodes.map((n) => (
              <li key={n.id} className="rounded border border-line bg-white px-3 py-2">
                <button type="button" className="text-left font-medium hover:underline" onClick={() => onOpen(n.id)}>{n.title}</button>
                {connections.get(n.id)?.length ? (
                  <ul className="mt-1 flex flex-col gap-0.5 text-sm">
                    {connections.get(n.id)!.map((c) => (
                      <li key={c.id} className="text-muted">
                        → <button type="button" className="text-ink hover:underline" onClick={() => onOpen(c.id)}>{byId.get(c.id)?.title}</button> <span className="text-xs">({c.label})</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">No connections.</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
