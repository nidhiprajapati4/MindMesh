# MindMesh AI — Phase 4: Ask your notes

Status: **Built and tested with a fake answer model; the Claude evaluation is pending your API key.** 125 automated API tests pass (98 from Phases 1–3, 27 new), and 7 browser scenarios passed on a local test stack. 3 bugs were found and fixed along the way. The "Both" search ranking was fixed too: reworded-query MRR went from 0.68 to **0.93**.

## 1. What Phase 4 adds
| Feature | Details |
|---|---|
| **Ask your notes** | Ask a question in plain language. MindMesh finds the most relevant notes and Claude writes a short answer **only from them** |
| **Citations** | Every claim carries numbered chips **[1] [2]**. Hover or focus shows the note title and the exact quoted passage; click opens the note |
| **Honest "not found"** | If no note is relevant, the answer says so immediately, **without calling (or paying for) the model** |
| **Streaming + Stop** | The answer appears as it's written. Stop cancels the model call, and the partial answer is kept, marked "stopped" |
| **Conversations** | Follow-up questions keep context. History in the sidebar (open, rename, delete); 👍/👎 per answer |
| **Shortcuts** | `?` on the notes page opens Ask; Enter asks, Shift+Enter adds a new line |
| **Better "Both" search** | Weak keyword hits no longer outrank real meaning matches (section 6) |

## 2. How it works
```
question ─► retrieve: Phase 3 meaning search, top ≤ 8 notes, best ≤ 2 passages each, ≤ 6k tokens
          ─► nothing above the similarity threshold? ─► "I couldn't find anything about that in your notes."
          ─► Claude: fixed system rules + one citable `document` per note + the question
          ─► stream `start` (sources) → `text` / `citation` → `done`  (or `error`)
          ─► save the turn (answer, citations, sources, tokens, cost) and charge the daily budget
```
- **Citations come from the API itself.** Each note is sent as a plain-text `document` block with `citations: {enabled: true}`. Claude returns which document each sentence quotes and the exact quoted text, so a chip can't point to a note that wasn't used.
- **Notes are data, not instructions.** The system prompt tells Claude to answer only from the documents, to ignore instructions written inside them (for example in a saved web page), and to say plainly when the notes don't contain the answer.
- **Only the asking user's notes** are ever retrieved, with the same owner, trash and archive checks as search.
- **Follow-ups.** A question that leans on the conversation ("and how much does it cost?", "what about that one") is searched together with the previous question. A self-contained question is searched on its own, so changing topic doesn't drag in notes about the old one. The follow-up check is English-only; other languages are searched as written.
- **One AI client** (`platform/ai-client.ts`, ADR-006) handles:
  - the budget check before the call, and charging the real token counts after
  - a 20 s wait limit for the first word and a 2-minute cap per answer
  - retries only before any text has streamed, so the user never sees text from two attempts
  - cancellation, and logging of model, tokens, cost and latency (never the question or the notes)

## 3. Answer model
| `ANSWER_PROVIDER` | Model | Cost | Use |
|---|---|---|---|
| `anthropic` | `claude-opus-5-5` (change with `ANSWER_MODEL`) | $4 / $20 per 1M input/output tokens, about **$0.03 per question** | real answers; chosen automatically when `ANTHROPIC_API_KEY` is set |
| `fake` | quotes the first sentence of matching notes | free | tests, and the default while no key is set |

Claude settings:
- `output_config.effort: "medium"`; thinking is always on for this model.
- `max_tokens` 4000.
- The fixed system prompt is cached.
- **Server-side fallback** (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`): if Claude declines a request on safety grounds, the API retries it on a suitable fallback model in the same call. Tell me if you'd rather turn this off.
- The SDK's own retries are off; the AI client owns retries.

**To switch on real answers:** add `ANTHROPIC_API_KEY=...` to `apps/api/.env` and restart the API. The tests always force the fake model, so a key in `.env` can never make them call or bill the API.

## 4. Configuration and API
New in `apps/api/.env` (all optional): `ANTHROPIC_API_KEY`, `ANSWER_PROVIDER` (`anthropic` | `fake`), `ANSWER_MODEL` (default `claude-opus-5-5`). Answers count against the existing `AI_DAILY_TOKEN_BUDGET`.

| Method | Path | Notes |
|---|---|---|
| POST | `/api/ask` | `{ question, conversationId? }` → `text/event-stream`: `start {conversationId, sources}`, `text {text}`, `citation {source, quote}`, `error {code, message}`, `done {conversationId, turnIndex, turn}`. Before streaming: `400` validation, `404` unknown conversation, `429` `QUOTA_EXCEEDED` or `RATE_LIMITED` (10 questions/minute per user) |
| GET | `/api/conversations` | Newest first: `_id, title, updatedAt, turnCount` |
| GET / PATCH / DELETE | `/api/conversations/:id` | Read, rename `{title}`, delete (owner only) |
| POST | `/api/conversations/:id/turns/:n/feedback` | `{ rating: "up" \| "down" \| null, comment? }` |

New collection: `conversations` (up to 50 turns each). A turn's `status` is `complete`, `not_found`, `stopped` or `error`.

## 5. Answer evaluation
`npm run eval:ask -w apps/api` runs `apps/api/eval/ask/questions.json` through the real pipeline over the Phase 3 dataset (40 notes) and writes [`docs/eval/phase4.md`](docs/eval/phase4.md):
- **14 answerable questions**, each with its expected note and key facts.
- **6 unanswerable questions**, two of them close to an existing note: "How many nodes does our Kubernetes cluster have?" and "What is the interest rate on my mortgage?".

It scores, with no AI judge: retrieval, citation accuracy, fact coverage, declining correctly, and cost and latency.

**Run so far: fake answer model (harness check).**
- Retrieval: **the expected note was among the sources for all 14 answerable questions.** This is real, since retrieval uses the actual local model.
- **5 of the 6 unanswerable questions were declined without a model call.**
- The 6th (Kubernetes) retrieves a related note, so the model *is* called; that's the key case for Claude to handle by saying "not in your notes".
- Fact coverage and abstention from the fake model are meaningless and are labelled as such.

**Pending:** `npm run eval:ask -w apps/api -- --paid`, with Claude, costs about **$0.60**. It refuses to run without `--paid`, so it can't spend money by accident.

## 6. "Both" search ranking fix
Phase 3 found that Both ranked reworded-query matches lower than Meaning (MRR 0.68 vs 0.93), because a note matching one incidental word (*Kubernetes probes* for "…remote **service** keeps timing out") outranked the right note. Two changes, both measured with `npm run eval:search`:
1. **Weak keyword hits are dropped from the fusion:** a hit must match at least 2, or half, of the question's content words. Keyword-only mode is unchanged.
2. **Meaning results count 1.5×** in rank fusion. The sweep in `docs/eval/phase3.md` shows 1.5 reaches the best score, and higher weights add nothing.

| Both mode | Before | After |
|---|---|---|
| Reworded queries: recall@5 / MRR | 95% / 0.68 | 95% / **0.93** |
| Keyword-style queries: recall@5 / MRR | 100% / 1.00 | 100% / 1.00 |
| Off-topic queries | no results | no results |

## 7. Tests
`npm test -w apps/api`: **125 tests, all passing** (27 new).

| Suite | New tests | Covers |
|---|---|---|
| `platform/generation/generation.test.ts` | 11 | Fake answers stream text and citations and charge usage; "not found"; over budget refused before the call; transient errors retried only before text streams; first-token timeout; Stop cancels without retry; a provider that ignores cancellation can't hang the request. **Claude provider replayed from a recorded stream (no network):** request shape (documents with citations, cached system prompt, effort, fallbacks beta), streamed text and citations parsed, real token usage, refusal handling, 5xx retryable and 400 not |
| `test/phase4.test.ts` | 13 | Ask streams sources, text and citations, then saves the turn; nothing relevant gives "not found" with **no model call**; follow-ups send history and keep the topic; **a topic change doesn't drag in old notes**; **user B never gets user A's notes or conversations**; trashed notes never used; validation and sign-in; 429 over budget before streaming; model failure gives a friendly error (no internals leaked); refusal; **Stop cancels the model and saves the partial answer**; 10 questions/minute limit; conversations list, rename, feedback, delete |
| `ai-processing.test.ts` additions | 3 | Follow-up detection; weighted fusion; keyword-hit coverage |

### Browser tests
Run on the local test stack (Auth emulator, in-memory MongoDB, API :4100, worker, web :3100), with the **real local embedding model** for retrieval and the **fake answer model**.

| ID | Steps | Expected | Result |
|---|---|---|---|
| UI-P4-01 | Press `?` on the notes page | Ask page opens with the question box focused; empty state explains what Ask does | ✅ Pass |
| UI-P4-02 | Ask "When is my sourdough starter ready to bake with?" | Answer streams in; citation chip **1** right after the cited text; "Sources used: Sourdough starter"; 👍/👎; URL and History show the new conversation | ✅ Pass |
| UI-P4-03 | Hover, then click the chip | Tooltip shows the note title and quoted passage; click opens *Sourdough starter* in the editor on the notes page | ✅ Pass |
| UI-P4-04 | Go back; ask a follow-up | Conversation restored; follow-up answered from the same note | ✅ Pass |
| UI-P4-05 | In the same conversation ask "volcanic eruptions in Iceland", then "What does direct air capture do?" and "And how much does it cost?" | Off-topic: **no sources**, "None of your notes seem to cover this", no model call. Follow-up keeps *Carbon capture* | ✅ Pass (after fix #3) |
| UI-P4-06 | 👍 an answer and reload; rename a conversation; delete another | Rating persists; new name shown; delete asks for confirmation, then removes it | ✅ Pass |
| UI-P4-07 | Phone width (375 px) | No sideways scrolling; question box pinned at the bottom | ✅ Pass |

Stop was verified by an API test (ASK-14), not in the browser: the fake model finishes too fast to click Stop.

### Bugs found and fixed
1. **Unhandled rejection after a cancel or timeout.** If the abort signal had already fired when a model call started, the shared `withTimeout` helper returned early without handling the call's own result, so its later failure surfaced as an unhandled rejection. It now always handles the underlying call. This also affected the Phase 3 embedding path.
2. **A model call that ignored cancellation could hang an answer forever**, even past the 2-minute cap. The AI client now races every call against its own abort signal.
3. **Changing topic mid-conversation kept retrieving the old topic.** "volcanic eruptions in Iceland", asked after sourdough questions, still got *Sourdough starter* as a source, because follow-up retrieval always searched with the previous question too. Now only questions phrased as follow-ups are.

Also improved: Rename/Delete in the conversation history now appear on hover or focus on desktop, so titles aren't squeezed.

## 8. Not in Phase 4 / limitations
- The real-Claude answer evaluation and a browser walkthrough with Claude wait for `ANTHROPIC_API_KEY`.
- Follow-up detection and the keyword-coverage stopword list are English-only.
- Rate limiting is per API process (in memory); several API instances would need a shared store.
- Conversations are capped at 50 turns; start a new one after that.
