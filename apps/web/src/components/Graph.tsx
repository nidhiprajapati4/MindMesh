'use client';

import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import { useEffect, useRef, useState } from 'react';
import type { GraphEdge, GraphNode } from '@/lib/api';

type SimNode = SimulationNodeDatum & GraphNode & { r: number };
type SimLink = SimulationLinkDatum<SimNode> & Omit<GraphEdge, 'source' | 'target'>;

type Props = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  colorOf: (n: GraphNode) => string;
  /** A note to centre and highlight (from the search box). */
  focusId: string | null;
  onOpen: (id: string) => void;
};

const radius = (degree: number) => 4 + Math.sqrt(degree) * 2.5;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * Notes as dots, connections as lines, laid out by a force simulation and drawn on a canvas (fast
 * with hundreds of notes). Wheel or pinch zooms, dragging the background pans, dragging a dot moves
 * it, clicking a dot opens the note, hovering shows its title and highlights its connections.
 */
export function Graph({ nodes, edges, colorOf, focusId, onOpen }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 800, h: 560 });
  const [hoverTitle, setHoverTitle] = useState<string | null>(null);
  // Mutable drawing state, kept out of React so the canvas can redraw every frame.
  const s = useRef({
    nodes: [] as SimNode[],
    links: [] as SimLink[],
    neighbours: new Map<string, Set<string>>(),
    view: { x: 0, y: 0, k: 1 },
    hover: null as SimNode | null,
    focus: null as string | null,
    positions: new Map<string, { x: number; y: number }>(),
    frame: 0,
    sim: null as Simulation<SimNode, SimLink> | null,
    colorOf,
  });
  s.current.colorOf = colorOf;

  const draw = () => {
    const st = s.current;
    cancelAnimationFrame(st.frame);
    st.frame = requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const { x, y, k } = st.view;
      ctx.translate(x, y);
      ctx.scale(k, k);

      const lit = st.hover?.id ?? st.focus;
      const near = lit ? st.neighbours.get(lit) ?? new Set<string>() : null;
      const isLit = (id: string) => !near || id === lit || near.has(id);

      for (const l of st.links) {
        const a = l.source as SimNode;
        const b = l.target as SimNode;
        const on = !near || ((a.id === lit || b.id === lit));
        ctx.globalAlpha = on ? (l.kind === 'link' ? 0.6 : 0.4) : 0.06;
        ctx.strokeStyle = l.kind === 'link' ? '#1A2233' : '#0F6E7A';
        ctx.lineWidth = (l.kind === 'link' ? 1.4 : 1) / Math.sqrt(k);
        ctx.setLineDash(l.kind === 'link' ? [] : [4 / k, 3 / k]);
        ctx.beginPath();
        ctx.moveTo(a.x!, a.y!);
        ctx.lineTo(b.x!, b.y!);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      for (const n of st.nodes) {
        ctx.globalAlpha = isLit(n.id) ? 1 : 0.2;
        ctx.fillStyle = st.colorOf(n);
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
        ctx.fill();
        if (n.id === lit) {
          ctx.lineWidth = 2 / k;
          ctx.strokeStyle = '#1A2233';
          ctx.stroke();
        }
      }

      // Titles: the highlighted note and its neighbours, or every note once zoomed in.
      ctx.globalAlpha = 1;
      ctx.font = `${12 / k}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (const n of st.nodes) {
        if (near ? !isLit(n.id) : k < 1.6) continue;
        const label = n.title.length > 40 ? `${n.title.slice(0, 39)}…` : n.title;
        ctx.lineWidth = 3 / k;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.strokeText(label, n.x!, n.y! + n.r + 2 / k);
        ctx.fillStyle = '#1A2233';
        ctx.fillText(label, n.x!, n.y! + n.r + 2 / k);
      }
    });
  };

  // Canvas size follows its container.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = Math.round(entry.contentRect.width);
      setSize({ w, h: clamp(Math.round(window.innerHeight * 0.7), 420, 900) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    draw();
  }, [size]); // eslint-disable-line react-hooks/exhaustive-deps

  // (Re)start the layout when the data changes; notes keep their place across reloads.
  useEffect(() => {
    const st = s.current;
    for (const n of st.nodes) st.positions.set(n.id, { x: n.x!, y: n.y! });
    const simNodes: SimNode[] = nodes.map((n) => ({ ...n, r: radius(n.degree), ...st.positions.get(n.id) }));
    const simLinks: SimLink[] = edges.map((e) => ({ ...e }));
    st.nodes = simNodes;
    st.links = simLinks;
    st.neighbours = new Map(nodes.map((n) => [n.id, new Set<string>()]));
    for (const e of edges) {
      st.neighbours.get(e.source)?.add(e.target);
      st.neighbours.get(e.target)?.add(e.source);
    }
    const sim = forceSimulation(simNodes)
      .force('link', forceLink<SimNode, SimLink>(simLinks).id((d) => d.id).distance((l) => (l.kind === 'link' ? 50 : 80)).strength((l) => (l.kind === 'link' ? 0.6 : 0.25)))
      .force('charge', forceManyBody().strength(-70).distanceMax(400))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide<SimNode>().radius((d) => d.r + 3))
      .stop();
    // Lay out up front rather than animating: it is quick, and doesn't stall in background tabs
    // (the animation timer pauses there). The simulation only runs live while a dot is dragged.
    sim.alpha(st.positions.size ? 0.3 : 1);
    while (sim.alpha() > sim.alphaMin()) sim.tick();
    sim.on('tick', draw);
    st.sim = sim;

    // Fit everything in view.
    if (simNodes.length) {
      const xs = simNodes.map((n) => n.x!);
      const ys = simNodes.map((n) => n.y!);
      const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
      const k = clamp(0.9 * Math.min(size.w / (x1 - x0 + 80), size.h / (y1 - y0 + 80)), 0.3, 2);
      st.view = { k, x: size.w / 2 - ((x0 + x1) / 2) * k, y: size.h / 2 - ((y0 + y1) / 2) * k };
    }
    draw();
    return () => {
      sim.stop();
    };
  }, [nodes, edges, size.w, size.h]); // eslint-disable-line react-hooks/exhaustive-deps

  // Centre on a note chosen in the search box.
  useEffect(() => {
    const st = s.current;
    st.focus = focusId;
    const n = st.nodes.find((x) => x.id === focusId);
    if (n?.x !== undefined) st.view = { k: Math.max(st.view.k, 1.4), x: size.w / 2 - n.x * Math.max(st.view.k, 1.4), y: size.h / 2 - n.y! * Math.max(st.view.k, 1.4) };
    draw();
  }, [focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pointer handling: pan, drag a note, pinch or wheel zoom, hover, click to open.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const st = s.current;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { node: SimNode | null; startX: number; startY: number; moved: boolean; viewX: number; viewY: number } | null = null;
    let pinch: { dist: number; k: number } | null = null;

    const local = (e: PointerEvent | WheelEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const toWorld = (p: { x: number; y: number }) => ({ x: (p.x - st.view.x) / st.view.k, y: (p.y - st.view.y) / st.view.k });
    const nodeAt = (p: { x: number; y: number }) => {
      const w = toWorld(p);
      let best: SimNode | null = null;
      let bestD = Infinity;
      for (const n of st.nodes) {
        const d = Math.hypot(n.x! - w.x, n.y! - w.y);
        if (d <= n.r + 4 / st.view.k && d < bestD) [best, bestD] = [n, d];
      }
      return best;
    };
    const zoomAt = (p: { x: number; y: number }, k: number) => {
      const nk = clamp(k, 0.2, 5);
      const w = toWorld(p);
      st.view = { k: nk, x: p.x - w.x * nk, y: p.y - w.y * nk };
      draw();
    };

    const onDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, local(e));
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), k: st.view.k };
        drag = null;
        return;
      }
      const p = local(e);
      const node = nodeAt(p);
      drag = { node, startX: p.x, startY: p.y, moved: false, viewX: st.view.x, viewY: st.view.y };
      if (node) {
        node.fx = node.x;
        node.fy = node.y;
      }
    };
    const onMove = (e: PointerEvent) => {
      const p = local(e);
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, p);
      if (pinch && pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        zoomAt({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, (pinch.k * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist);
        return;
      }
      if (drag) {
        if (Math.hypot(p.x - drag.startX, p.y - drag.startY) > 4) drag.moved = true;
        if (!drag.moved) return;
        if (drag.node) {
          const w = toWorld(p);
          drag.node.fx = w.x;
          drag.node.fy = w.y;
          st.sim?.alphaTarget(0.2).restart();
        } else {
          st.view = { ...st.view, x: drag.viewX + p.x - drag.startX, y: drag.viewY + p.y - drag.startY };
          draw();
        }
        return;
      }
      const hit = nodeAt(p);
      if (hit !== st.hover) {
        st.hover = hit;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
        setHoverTitle(hit?.title ?? null);
        draw();
      }
    };
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (!drag) return;
      const { node, moved } = drag;
      drag = null;
      if (node) {
        node.fx = null;
        node.fy = null;
        st.sim?.alphaTarget(0);
        if (!moved) onOpen(node.id);
      }
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(local(e), st.view.k * Math.exp(-e.deltaY * 0.0015));
    };
    const onLeave = () => {
      if (st.hover) {
        st.hover = null;
        setHoverTitle(null);
        draw();
      }
    };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('wheel', onWheel);
    };
  }, [onOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={wrapRef} className="relative w-full overflow-hidden rounded border border-line bg-white">
      <canvas
        ref={canvasRef}
        style={{ width: size.w, height: size.h, touchAction: 'none', cursor: 'grab' }}
        role="img"
        aria-label={`Graph of ${nodes.length} notes and ${edges.length} connections. Use the list view for a text version.`}
      />
      <p aria-live="polite" className="pointer-events-none absolute left-2 top-2 rounded bg-white/90 px-2 py-0.5 text-xs text-muted">
        {hoverTitle ? `${hoverTitle} · click to open` : 'Scroll or pinch to zoom · drag to move · click a dot to open'}
      </p>
    </div>
  );
}
