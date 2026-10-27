'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AnswerView, type AnswerTurn } from '@/components/AnswerView';
import { api, ApiError, type Conversation, type ConversationSummary } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { streamAsk } from '@/lib/sse';

type Usage = { embedTokens: number; genTokens: number; budget: number };
type AnswerSetup = { available: boolean; provider: 'anthropic' | 'fake' | 'none'; model: string | null };

const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function AskPage() {
  const { user, loading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const conversationId = params.get('c');

  const [list, setList] = useState<ConversationSummary[]>([]);
  const [conversation, setConversation] = useState<Conversation | null>(null);
  const [live, setLive] = useState<AnswerTurn | null>(null);
  const [question, setQuestion] = useState('');
  const [error, setError] = useState('');
  const [usage, setUsage] = useState<Usage | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [setup, setSetup] = useState<AnswerSetup | null>(null);
  const stopRef = useRef<AbortController | null>(null);
  // The conversation the answer being written belongs to (null = a new one), and the one on screen.
  const liveForRef = useRef<string | null>(null);
  const viewRef = useRef(conversationId);
  viewRef.current = conversationId;
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!loading && !user) router.replace('/login');
  }, [user, loading, router]);

  const loadList = useCallback(async () => {
    const [l, u] = await Promise.all([api<ConversationSummary[]>('/api/conversations'), api<Usage>('/api/search/usage')]);
    setList(l);
    setUsage(u);
  }, []);

  useEffect(() => {
    if (!user) return;
    loadList().catch((e) => setError(message(e, 'Could not load conversations')));
    api<AnswerSetup>('/api/ask/status').then(setSetup).catch(() => undefined);
  }, [user, loadList]);

  // Opening another conversation while an answer is being written stops that answer
  // (the server keeps what was written, marked as stopped) instead of showing it in the wrong place.
  useEffect(() => {
    if (stopRef.current && liveForRef.current !== conversationId) stopRef.current.abort();
  }, [conversationId]);

  // Open the conversation named in the URL (?c=…), or a blank one.
  useEffect(() => {
    if (!user) return;
    if (!conversationId) return setConversation(null);
    if (conversation?._id === conversationId) return;
    api<Conversation>(`/api/conversations/${conversationId}`)
      .then(setConversation)
      .catch((e) => setError(message(e, 'Could not open that conversation')));
  }, [user, conversationId, conversation?._id]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [conversation?.turns.length, live?.segments]);

  useEffect(() => inputRef.current?.focus(), [conversationId]);

  const busy = !!live && live.status === 'streaming';

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    const q = question.trim();
    if (!q || busy) return;
    setError('');
    setQuestion('');
    const stop = new AbortController();
    stopRef.current = stop;
    const origin = conversation?._id ?? null;
    liveForRef.current = origin;
    const stillViewing = () => (viewRef.current ?? null) === origin;
    setLive({ question: q, segments: [], sources: [], status: 'streaming', error: null });
    let newId: string | null = null;

    try {
      await streamAsk(
        { question: q, conversationId: conversation?._id },
        (ev) => {
          switch (ev.event) {
            case 'start':
              newId = ev.data.conversationId;
              setLive((t) => t && { ...t, sources: ev.data.sources });
              break;
            case 'text':
              // Text after a citation starts a new segment, so chips stay next to the text they back.
              setLive((t) => {
                if (!t) return t;
                const last = t.segments.at(-1);
                const segments = !last || last.citations.length ? [...t.segments, { text: ev.data.text, citations: [] }] : [...t.segments.slice(0, -1), { ...last, text: last.text + ev.data.text }];
                return { ...t, segments };
              });
              break;
            case 'citation':
              setLive((t) => {
                if (!t?.segments.length) return t;
                const last = t.segments.at(-1)!;
                return { ...t, segments: [...t.segments.slice(0, -1), { ...last, citations: [...last.citations, ev.data] }] };
              });
              break;
            case 'error':
              setLive((t) => t && { ...t, error: ev.data.message });
              break;
            case 'done':
              if (stillViewing()) {
                setConversation((c) => ({
                  _id: ev.data.conversationId,
                  title: c?.title ?? q.slice(0, 80),
                  updatedAt: new Date().toISOString(),
                  turns: [...(c?.turns ?? []), ev.data.turn],
                }));
              }
              setLive(null);
              break;
          }
        },
        stop.signal
      );
      if (stop.signal.aborted) {
        // The server saves the partial answer; reload the conversation to show it as stopped
        // (also when Stop came before the server said which conversation it is).
        setLive(null);
        const id = newId ?? origin;
        if (id && stillViewing()) setConversation(await api<Conversation>(`/api/conversations/${id}`));
      }
    } catch (err) {
      setLive(null);
      setQuestion(q); // let them retry without retyping
      setError(err instanceof ApiError && err.code === 'QUOTA_EXCEEDED' ? `${err.message} You can still search your notes by keyword.` : message(err, 'Could not ask that question'));
    } finally {
      stopRef.current = null;
      liveForRef.current = null;
      // Show the new conversation's URL, unless the user has moved to another one meanwhile.
      if (newId && newId !== viewRef.current && stillViewing()) router.replace(`/ask?c=${newId}`);
      loadList().catch(() => undefined);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  const feedback = async (turnIndex: number, rating: 'up' | 'down' | null) => {
    if (!conversation) return;
    setConversation({ ...conversation, turns: conversation.turns.map((t, i) => (i === turnIndex ? { ...t, feedback: { ...t.feedback, rating } } : t)) });
    await api(`/api/conversations/${conversation._id}/turns/${turnIndex}/feedback`, { method: 'POST', body: JSON.stringify({ rating, comment: '' }) }).catch((e) =>
      setError(message(e, 'Could not save your feedback'))
    );
  };

  const rename = async (id: string, title: string) => {
    setRenaming(null);
    if (!title.trim()) return;
    try {
      await api(`/api/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) });
      if (conversation?._id === id) setConversation({ ...conversation, title: title.trim() });
      await loadList();
    } catch (e) {
      setError(message(e, 'Could not rename'));
    }
  };

  const remove = async (c: ConversationSummary) => {
    if (!confirm(`Delete “${c.title}”? This cannot be undone.`)) return;
    try {
      await api(`/api/conversations/${c._id}`, { method: 'DELETE' });
      if (conversation?._id === c._id) router.replace('/ask');
      await loadList();
    } catch (e) {
      setError(message(e, 'Could not delete'));
    }
  };

  if (loading || !user) return null;

  const openNote = (noteId: string) => router.push(`/notes?open=${noteId}`);
  const usedShare = usage ? (usage.embedTokens + usage.genTokens) / usage.budget : 0;
  const turns = conversation?.turns ?? [];

  return (
    <div className="mx-auto grid min-h-screen max-w-6xl gap-6 px-4 py-6 md:grid-cols-[16rem_1fr]">
      <aside className="flex flex-col gap-3">
        <Link href="/notes" className="text-sm text-accent hover:underline">← Back to notes</Link>
        <h1 className="font-serif text-2xl font-semibold">Ask your notes</h1>
        <button className="btn-primary" onClick={() => router.push('/ask')} disabled={busy}>New conversation</button>
        <hr className="border-line" />
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">History</h2>
        {!list.length && <p className="text-xs text-muted">Your conversations will appear here.</p>}
        <ul className="flex flex-col gap-0.5">
          {list.map((c) =>
            renaming === c._id ? (
              <li key={c._id}>
                <input
                  autoFocus
                  className="field py-1"
                  defaultValue={c.title}
                  maxLength={120}
                  aria-label={`New name for ${c.title}`}
                  onBlur={(e) => rename(c._id, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                />
              </li>
            ) : (
              <li key={c._id} className="group flex items-center gap-1">
                <button
                  className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${c._id === conversationId ? 'bg-accent text-white' : 'hover:bg-white'}`}
                  aria-current={c._id === conversationId ? 'page' : undefined}
                  onClick={() => router.push(`/ask?c=${c._id}`)}
                  onDoubleClick={() => setRenaming(c._id)}
                  title={c.title}
                >
                  {c.title}
                </button>
                <button className="shrink-0 rounded px-1 text-xs text-muted hover:bg-white hover:text-ink md:opacity-0 md:focus:opacity-100 md:group-hover:opacity-100" onClick={() => setRenaming(c._id)} aria-label={`Rename ${c.title}`}>Rename</button>
                <button className="shrink-0 rounded px-1 text-xs text-muted hover:bg-white hover:text-red-700 md:opacity-0 md:focus:opacity-100 md:group-hover:opacity-100" onClick={() => remove(c)} aria-label={`Delete ${c.title}`}>Delete</button>
              </li>
            )
          )}
        </ul>
      </aside>

      <main className="flex min-w-0 flex-col gap-4">
        {error && (
          <p role="alert" className="flex items-center justify-between rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
            <button className="underline" onClick={() => setError('')}>Dismiss</button>
          </p>
        )}
        {setup?.provider === 'fake' && (
          <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Demo answers: no AI model is connected, so answers just quote matching notes. Add <code>ANTHROPIC_API_KEY</code> to the API’s settings for real answers.
          </p>
        )}
        {setup && !setup.available && (
          <p role="status" className="rounded border border-line bg-white px-3 py-2 text-sm text-muted">
            Answers aren’t set up on this server yet. You can still <Link href="/notes" className="text-accent underline">search your notes</Link>.
          </p>
        )}
        {usedShare >= 0.8 && (
          <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            You’ve used {Math.min(100, Math.round(usedShare * 100))}% of today’s AI budget. It resets at midnight UTC.
          </p>
        )}

        {!turns.length && !live && (
          <div className="rounded-lg border border-dashed border-line p-6 text-muted">
            <p className="font-serif text-lg text-ink">Ask a question in your own words.</p>
            <p className="mt-1 text-sm">Answers are written only from your notes, and every claim links to the note it came from. If your notes don’t cover it, you’ll be told so.</p>
          </div>
        )}

        <div className="flex flex-col gap-6">
          {turns.map((t, i) => (
            <AnswerView key={i} turn={t} onOpenNote={openNote} onFeedback={(r) => feedback(i, r)} />
          ))}
          {live && <AnswerView turn={live} onOpenNote={openNote} />}
          <div ref={endRef} />
        </div>

        <form onSubmit={submit} className="sticky bottom-0 mt-auto flex items-end gap-2 bg-paper py-3">
          <textarea
            ref={inputRef}
            className="field min-h-[2.75rem] flex-1 resize-y"
            rows={2}
            maxLength={1000}
            placeholder={turns.length ? 'Ask a follow-up…' : 'What would you like to know from your notes?'}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKey}
            aria-label="Your question"
            disabled={setup?.available === false}
          />
          {busy ? (
            <button type="button" className="btn-ghost" onClick={() => stopRef.current?.abort()}>Stop</button>
          ) : (
            <button type="submit" className="btn-primary" disabled={!question.trim() || setup?.available === false}>Ask</button>
          )}
        </form>
        <p className="-mt-3 text-xs text-muted">Enter to ask · Shift+Enter for a new line</p>
      </main>
    </div>
  );
}

export default function AskPageWrapper() {
  // useSearchParams needs a Suspense boundary for static rendering.
  return (
    <Suspense fallback={null}>
      <AskPage />
    </Suspense>
  );
}
