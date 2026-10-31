'use client';

import type { TurnSegment, TurnStatus } from '@/lib/api';

export type AnswerTurn = {
  question: string;
  segments: TurnSegment[];
  sources: { noteId: string; title: string }[];
  status: TurnStatus | 'streaming';
  error: string | null;
  feedback?: { rating: 'up' | 'down' | null };
};

type Props = {
  turn: AnswerTurn;
  onOpenNote: (noteId: string) => void;
  /** Omitted while the answer is still being written. */
  onFeedback?: (rating: 'up' | 'down' | null) => void;
  /** Bookmarks the answer; omitted while it is being written or in the Saved list. */
  saved?: boolean;
  onToggleSave?: () => void;
};

function CitationChip({ n, title, quote, onOpen }: { n: number; title: string; quote: string; onOpen: () => void }) {
  return (
    <span className="group relative inline-block align-baseline">
      <button
        className="mx-0.5 rounded bg-accent/10 px-1 text-xs font-semibold text-accent hover:bg-accent hover:text-white"
        onClick={onOpen}
        aria-label={`Source ${n}: ${title}. Quoted: ${quote}`}
      >
        {n}
      </button>
      {/* Shown on hover and keyboard focus; the button's label carries the same text for screen readers. */}
      <span
        aria-hidden
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden w-72 -translate-x-1/2 rounded border border-line bg-white p-2 text-left text-xs font-normal text-ink shadow-lg group-focus-within:block group-hover:block"
      >
        <span className="block font-semibold">{title}</span>
        <span className="mt-1 block italic text-muted">“{quote}”</span>
      </span>
    </span>
  );
}

const STATUS_NOTE: Partial<Record<AnswerTurn['status'], string>> = {
  stopped: 'You stopped this answer.',
  not_found: 'None of your notes seem to cover this. Try different words, or search your notes.',
};

export function AnswerView({ turn, onOpenNote, onFeedback, saved, onToggleSave }: Props) {
  const cited = new Set(turn.segments.flatMap((s) => s.citations.map((c) => c.source)));
  const titleOf = (i: number) => turn.sources[i]?.title || 'Untitled';

  return (
    <article className="flex flex-col gap-2">
      <p className="self-end rounded-lg bg-accent px-3 py-2 text-white">{turn.question}</p>

      <div className="rounded-lg border border-line bg-white p-4">
        <div className="whitespace-pre-wrap font-serif leading-relaxed" aria-live={turn.status === 'streaming' ? 'polite' : undefined}>
          {turn.segments.map((seg, i) => (
            <span key={i}>
              {seg.text}
              {[...new Map(seg.citations.map((c) => [c.source, c])).values()].map((c) => (
                <CitationChip key={c.source} n={c.source + 1} title={titleOf(c.source)} quote={c.quote} onOpen={() => onOpenNote(turn.sources[c.source].noteId)} />
              ))}
            </span>
          ))}
          {turn.status === 'streaming' && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-accent align-middle" aria-hidden />}
          {turn.status === 'streaming' && !turn.segments.some((s) => s.text) && <span className="text-muted">Reading your notes…</span>}
        </div>

        {turn.error && <p role="alert" className="mt-2 text-sm text-red-700">{turn.error}</p>}
        {STATUS_NOTE[turn.status] && <p className="mt-2 text-sm text-muted">{STATUS_NOTE[turn.status]}</p>}

        {!!turn.sources.length && (
          <div className="mt-3 border-t border-line pt-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Sources used</h3>
            <ol className="mt-1 flex flex-col gap-0.5 text-sm">
              {turn.sources.map((s, i) => (
                <li key={i} className="flex gap-2">
                  <span className="w-4 shrink-0 text-right text-xs text-muted">{i + 1}</span>
                  <button className={`truncate text-left underline-offset-2 hover:underline ${cited.has(i) ? 'font-medium' : 'text-muted'}`} onClick={() => onOpenNote(s.noteId)}>
                    {s.title || 'Untitled'}
                  </button>
                  {!cited.has(i) && turn.status !== 'streaming' && <span className="text-xs text-muted">(read, not cited)</span>}
                </li>
              ))}
            </ol>
          </div>
        )}

        {(onFeedback || onToggleSave) && (turn.status === 'complete' || turn.status === 'not_found') && (
          <div className="mt-3 flex items-center gap-1 text-sm text-muted">
            {onFeedback && 'Was this helpful?'}
            {onFeedback && (['up', 'down'] as const).map((r) => (
              <button
                key={r}
                aria-pressed={turn.feedback?.rating === r}
                aria-label={r === 'up' ? 'Helpful' : 'Not helpful'}
                onClick={() => onFeedback(turn.feedback?.rating === r ? null : r)}
                className={`rounded px-1.5 py-0.5 ${turn.feedback?.rating === r ? 'bg-select ring-1 ring-selectLine' : 'hover:bg-paper'}`}
              >
                {r === 'up' ? '👍' : '👎'}
              </button>
            ))}
            {onToggleSave && (
              <button
                aria-pressed={!!saved}
                onClick={onToggleSave}
                className={`ml-auto rounded px-2 py-1 text-sm font-medium ${saved ? 'bg-select text-selectInk' : 'text-accent hover:bg-paper'}`}
                title={saved ? 'Remove from your saved answers' : 'Save this answer to read again later'}
              >
                {saved ? '★ Saved' : '☆ Save answer'}
              </button>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
