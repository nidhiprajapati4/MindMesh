import { ApiError, apiFetch, type AnswerSource, type Turn } from './api';

export type AskEvent =
  | { event: 'start'; data: { conversationId: string; sources: AnswerSource[] } }
  | { event: 'text'; data: { text: string } }
  | { event: 'citation'; data: { source: number; quote: string } }
  | { event: 'error'; data: { code: string; message: string } }
  | { event: 'done'; data: { conversationId: string; turnIndex: number; turn: Turn } };

/**
 * Asks a question and calls `onEvent` for each server-sent event as it arrives.
 * Uses fetch rather than EventSource, which can't POST or send the auth header.
 * Errors before the stream starts (validation, budget, rate limit) throw an ApiError.
 * Aborting `signal` stops the answer; the server saves what was written so far.
 */
export async function streamAsk(body: { question: string; conversationId?: string }, onEvent: (e: AskEvent) => void, signal: AbortSignal) {
  const res = await apiFetch('/api/ask', { method: 'POST', body: JSON.stringify(body), signal });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(err.error ?? `Request failed (${res.status})`, res.status, err.code);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (event && data) onEvent({ event, data: JSON.parse(data) } as AskEvent);
      }
    }
  } catch (e) {
    if ((e as Error).name !== 'AbortError') throw e;
  }
}
