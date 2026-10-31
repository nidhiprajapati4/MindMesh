'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { AnswerView, type AnswerTurn } from '@/components/AnswerView';
import { Brand } from '@/components/Brand';
import { api, ApiError, errorMessage, type Conversation, type ConversationSummary, type SavedAnswer, type SavedSummary } from '@/lib/api';
import { useAuth } from '@/lib/auth-context';
import { streamAsk } from '@/lib/sse';
import { useSpeechInput } from '@/lib/speech';

/** After a spoken question, wait this long before sending, so it can be cancelled or fixed. */
const VOICE_SEND_DELAY_MS = 2500;

type Usage = { embedTokens: number; genTokens: number; budget: number };
type AnswerSetup = { available: boolean; provider: 'anthropic' | 'quotes' | 'fake'; model: string };

const message = errorMessage;

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
  const [tab, setTab] = useState<'history' | 'saved'>('history');
  const [saved, setSaved] = useState<SavedSummary[]>([]);
  const [savedOpen, setSavedOpen] = useState<SavedAnswer | null>(null);
  // Set while a spoken question waits to be sent (it can still be cancelled).
  const [voiceSending, setVoiceSending] = useState(false);
  const voiceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const submitRef = useRef<(e?: FormEvent, text?: string) => Promise<void>>(async () => undefined);
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
    const [l, u, s] = await Promise.all([
      api<ConversationSummary[]>('/api/conversations'),
      api<Usage>('/api/search/usage'),
      api<SavedSummary[]>('/api/saved').catch(() => null),
    ]);
    setList(l);
    setUsage(u);
    if (s) setSaved(s);
  }, []);

  const cancelVoiceSend = useCallback(() => {
    if (voiceTimer.current) clearTimeout(voiceTimer.current);
    voiceTimer.current = null;
    setVoiceSending(false);
  }, []);
  useEffect(() => cancelVoiceSend, [cancelVoiceSend]);

  // Spoken words fill the box as they are recognised; a finished sentence is sent after a short pause.
  const voice = useSpeechInput((text, final) => {
    setQuestion(text);
    if (!final || !text) return;
    setVoiceSending(true);
    voiceTimer.current = setTimeout(() => {
      voiceTimer.current = null;
      setVoiceSending(false);
      void submitRef.current(undefined, text);
    }, VOICE_SEND_DELAY_MS);
  });
  const toggleMic = () => {
    cancelVoiceSend();
    if (voice.listening) voice.stop();
    else {
      setQuestion('');
      voice.start();
    }
  };

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

  const submit = async (e?: FormEvent, text?: string) => {
    e?.preventDefault();
    cancelVoiceSend();
    const q = (text ?? question).trim();
    if (!q || busy) return;
    setSavedOpen(null);
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

  submitRef.current = submit;

  const savedIdOf = (turnIndex: number) => saved.find((s) => s.conversationId === conversation?._id && s.turnIndex === turnIndex)?._id;
  const toggleSave = async (turnIndex: number) => {
    if (!conversation) return;
    try {
      const id = savedIdOf(turnIndex);
      if (id) await api(`/api/saved/${id}`, { method: 'DELETE' });
      else await api('/api/saved', { method: 'POST', body: JSON.stringify({ conversationId: conversation._id, turnIndex }) });
      await loadList();
    } catch (e) {
      setError(message(e, 'Could not update your saved answers'));
    }
  };
  const openSaved = async (id: string) => {
    try {
      setSavedOpen(await api<SavedAnswer>(`/api/saved/${id}`));
      if (conversationId) router.replace('/ask');
    } catch (e) {
      setError(message(e, 'Could not open that saved answer'));
    }
  };
  const removeSaved = async (s: SavedSummary) => {
    try {
      await api(`/api/saved/${s._id}`, { method: 'DELETE' });
      if (savedOpen?._id === s._id) setSavedOpen(null);
      await loadList();
    } catch (e) {
      setError(message(e, 'Could not remove that saved answer'));
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
        <Brand />
        <Link href="/notes" className="text-sm text-accent hover:underline">← Back to notes</Link>
        <h1 className="font-serif text-2xl font-semibold">Ask your notes</h1>
        <button className="btn-primary" onClick={() => { setSavedOpen(null); router.push('/ask'); }} disabled={busy}>New conversation</button>
        <hr className="border-line" />
        <div role="tablist" aria-label="Conversations" className="grid grid-cols-2 gap-0.5 rounded-lg bg-white p-0.5 text-xs font-medium">
          {(['history', 'saved'] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={`rounded-md py-1.5 transition-colors ${tab === t ? 'bg-select text-selectInk shadow-sm' : 'text-muted hover:text-ink'}`}
            >
              {t === 'history' ? 'History' : 'Saved'} <span className="font-normal text-muted">({t === 'history' ? list.length : saved.length})</span>
            </button>
          ))}
        </div>
        {tab === 'saved' && (
          <>
            {!saved.length && <p className="text-xs text-muted">Tap “Save answer” under an answer to keep it here.</p>}
            <ul className="flex flex-col gap-0.5">
              {saved.map((s) => (
                <li key={s._id} className="group flex items-center gap-1">
                  <button
                    className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${savedOpen?._id === s._id ? 'bg-select font-medium text-selectInk' : 'hover:bg-white'}`}
                    aria-current={savedOpen?._id === s._id ? 'page' : undefined}
                    onClick={() => void openSaved(s._id)}
                    title={s.question}
                  >
                    {s.question}
                  </button>
                  <button className="shrink-0 rounded px-1 text-xs text-muted hover:bg-white hover:text-red-700 md:opacity-0 md:focus:opacity-100 md:group-hover:opacity-100" onClick={() => void removeSaved(s)} aria-label={`Remove saved answer: ${s.question}`}>Remove</button>
                </li>
              ))}
            </ul>
          </>
        )}
        {tab === 'history' && !list.length && <p className="text-xs text-muted">Your conversations will appear here.</p>}
        <ul className={`flex flex-col gap-0.5 ${tab === 'history' ? '' : 'hidden'}`}>
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
                  className={`min-w-0 flex-1 truncate rounded px-2 py-1.5 text-left text-sm ${c._id === conversationId && !savedOpen ? 'bg-select font-medium text-selectInk' : 'hover:bg-white'}`}
                  aria-current={c._id === conversationId ? 'page' : undefined}
                  onClick={() => { setSavedOpen(null); router.push(`/ask?c=${c._id}`); }}
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
        {setup?.provider === 'quotes' && (
          <p role="status" className="rounded border border-line bg-white px-3 py-2 text-sm text-muted">
            Free mode: answers to questions about what’s in your notes are the sentences that best match, quoted with their source; they aren’t rewritten or summarised. Questions about your library itself, such as “how many notes do I have?” or “list my latest 5 documents”, are answered directly with counts and links.
          </p>
        )}
        {setup?.provider === 'fake' && (
          <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            Test answers: this server uses the test answerer, which only quotes the first sentence of matching notes.
          </p>
        )}
        {usedShare >= 0.8 && (
          <p role="status" className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            You’ve used {Math.min(100, Math.round(usedShare * 100))}% of today’s AI budget. It resets at midnight UTC.
          </p>
        )}

        {savedOpen && (
          <div className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">Saved answer · {new Date(savedOpen.createdAt).toLocaleDateString()}</p>
            <AnswerView turn={{ question: savedOpen.question, segments: savedOpen.segments, sources: savedOpen.sources, status: 'complete', error: null }} onOpenNote={openNote} />
          </div>
        )}

        {!savedOpen && !turns.length && !live && (
          <div className="rounded-lg border border-dashed border-line p-6 text-muted">
            <p className="font-serif text-lg text-ink">Ask a question in your own words.</p>
            <p className="mt-1 text-sm">Answers are written only from your notes, and every claim links to the note it came from. If your notes don’t cover it, you’ll be told so.</p>
          </div>
        )}

        <div className="flex flex-col gap-6">
          {!savedOpen && turns.map((t, i) => (
            <AnswerView key={i} turn={t} onOpenNote={openNote} onFeedback={(r) => feedback(i, r)} saved={!!savedIdOf(i)} onToggleSave={() => void toggleSave(i)} />
          ))}
          {live && <AnswerView turn={live} onOpenNote={openNote} />}
          <div ref={endRef} />
        </div>

        {voice.error && (
          <p role="alert" className="flex items-center justify-between rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {voice.error}
            <button className="underline" onClick={voice.clearError}>Dismiss</button>
          </p>
        )}
        {voice.listening && <p role="status" className="text-sm font-medium text-accent">Listening… speak your question. Tap the microphone to stop.</p>}
        {voiceSending && (
          <p role="status" className="flex items-center gap-3 text-sm text-muted">
            Sending your question…
            <button type="button" className="font-medium text-accent underline" onClick={cancelVoiceSend}>Cancel</button>
          </p>
        )}
        <form onSubmit={submit} className="sticky bottom-0 mt-auto flex items-end gap-2 bg-paper py-3">
          <button
            type="button"
            onClick={toggleMic}
            disabled={busy || !voice.supported}
            aria-pressed={voice.listening}
            aria-label={voice.listening ? 'Stop listening' : 'Ask by voice'}
            title={voice.supported ? (voice.listening ? 'Stop listening' : 'Ask by voice') : 'Voice input isn’t supported in this browser'}
            className={`relative grid h-14 w-14 shrink-0 place-items-center rounded-full border text-accent shadow-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${voice.listening ? 'border-selectLine bg-select text-selectInk' : 'border-line bg-white hover:border-accent hover:bg-accent/5'}`}
          >
            {voice.listening && <span className="absolute inset-0 animate-ping rounded-full bg-selectLine/40" aria-hidden />}
            <svg className="relative" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          </button>
          <textarea
            ref={inputRef}
            className="field min-h-[2.75rem] flex-1 resize-y"
            rows={2}
            maxLength={1000}
            placeholder={turns.length ? 'Ask a follow-up…' : 'What would you like to know from your notes?'}
            value={question}
            onChange={(e) => { cancelVoiceSend(); setQuestion(e.target.value); }}
            onKeyDown={onKey}
            aria-label="Your question"
          />
          {busy ? (
            <button type="button" className="btn-ghost" onClick={() => stopRef.current?.abort()}>Stop</button>
          ) : (
            <button type="submit" className="btn-primary" disabled={!question.trim()}>Ask</button>
          )}
        </form>
        <p className="-mt-3 text-xs text-muted">
          Enter to ask · Shift+Enter for a new line
          {!voice.supported && ' · Voice input isn’t supported in this browser (try Chrome, Edge or Safari)'}
        </p>
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
