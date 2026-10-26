# MindMesh AI — Phase 3: Ingestion, embeddings, semantic search

Status: **Implemented, evaluated and tested.** 98 automated API tests pass (60 from Phase 2, 38 new), and 6 browser scenarios passed on a local test stack, including paraphrase search with the real model. 1 bug was found in the browser and fixed. With the free local model, search by meaning finds **95%** of paraphrased queries in the top 5, versus **40%** for keyword search, with no results for off-topic queries (section 6).

## 1. What Phase 3 adds
| Spec ID | Feature | Details |
|---|---|---|
| FR-10 | Ingestion pipeline | Every create, edit, upload, link capture and restore queues the item for processing. A separate **worker** process extracts the text, cleans it, splits it into chunks, embeds them, and stores the vectors |
| FR-11 | Embeddings | One AI client for all model calls (ADR-006), with a 20 s timeout, up to 3 retries with backoff, a token and cost estimate per call, and usage logging |
| FR-12 | Search by meaning | `GET /api/search?mode=semantic` finds items about the same idea even when they share no words with the query |
| FR-13 | Hybrid search | `mode=hybrid` (the default) merges keyword and meaning results with reciprocal-rank fusion |
| — | Processing status | Cards show **Processing…** while an item is prepared, and **Failed + Retry** if it could not be |
| — | Daily AI budget | Per-user token counters; over budget returns `429 QUOTA_EXCEEDED`, and hybrid search falls back to keyword results |
| — | Search mode switch | **Keyword / Meaning / Both** next to the search box; the choice is remembered |
| H2 | Evaluation | 40 notes and 40 queries; a script reports recall@5 and MRR per mode (section 6) |

## 2. How it works
```
create / edit / upload / capture / restore
   └─ content hash changed? ── no ──► nothing to do (pin, tags, folder moves never re-embed)
                               yes
                                ▼
   processingJobs (MongoDB queue) ◄── worker claims atomically (findOneAndUpdate)
                                ▼
   extract ─► clean ─► chunk ─► embed (ai-client) ─► chunks collection ─► note.processing = ready
```
- **Extract.** Notes, snippets, ideas and uploaded documents use their text. Links fetch the page's readable text through the Phase 2 SSRF guard; if the page can't be read, the saved description is used.
- **Clean.** Readability-style: scripts, navigation, headers, footers and asides are removed; `<article>`/`<main>` is preferred; boilerplate lines ("Accept cookies", "All rights reserved") are dropped.
- **Chunk.** Splits on paragraphs, then sentences, with overlap between neighbouring chunks. Each chunk starts with the item's title. Size follows the model: ~200 tokens with 40 overlap for the local model (it reads at most ~256 word pieces), ~800 tokens with 100 overlap for OpenAI.
- **Retries.** A failed job runs again after 10 s and then 20 s. After 3 attempts it is marked failed and the card shows a friendly reason with a **Retry** button. Budget errors are not retried. A job stuck in "processing" for 5 minutes (crashed worker) is picked up again.
- **Edits during processing.** Each job carries the content hash it was queued for. If the item changes while the worker is busy, the stale result is thrown away and the new version is processed.
- **Trash.** Moving an item to the trash deletes its chunks immediately, so it can't appear in search. Restoring re-queues it. Delete forever and Empty trash remove chunks and jobs.
- **Search.** The query is embedded, the user's nearest chunks are found, chunks are grouped into items (best chunk = snippet), and ownership, trash/archive and filters are re-checked against the notes. Matches below a similarity threshold are dropped.

## 3. Embedding providers
No OpenAI key is needed to use Phase 3.

| `EMBEDDING_PROVIDER` | Model | Dims | Cost | Use |
|---|---|---|---|---|
| `local` (default) | `Xenova/all-MiniLM-L6-v2`, runs on the server's CPU | 384 | free | development and small deployments; the model (~23 MB) downloads on first use |
| `openai` | `text-embedding-3-small` (override with `EMBEDDING_MODEL`) | 1536 | ~$0.02 per 1M tokens | production; needs `OPENAI_API_KEY` |
| `fake` | hashed bag of words | 1024 | free | automated tests only |

**Switching provider:** set the variables, restart the API and worker, then run `npm run reembed -w apps/api`. It removes vectors from the old model, updates the Atlas index size, and re-queues every item. Search only ever compares vectors from the current model.

**The API and the worker must use the same provider.** The worker writes vectors with its model, and the API searches with its own. If they differ, items are marked ready but are invisible to meaning search. (This happened during testing, when an old worker was left running with the test provider; `npm run reembed` fixes it.)

**Windows note: pinned runtime.** `@huggingface/transformers` 3.8 wants ONNX Runtime 1.21, which needs the Visual C++ runtime 14.40 or newer. The dev machine has 14.34, so the root `package.json` has two npm `overrides`:
- `onnxruntime-node` is pinned to **1.19.2**, which works with the older runtime.
- transformers' `sharp` is aligned to **0.35.5**, the version Next.js uses, so only one image library is installed. MindMesh never passes images to transformers.

Once every dev machine has the newer runtime, the overrides can be removed. Linux servers never needed them.

## 4. Atlas Vector Search (spike: PASS)
`npm run spike:vector -w apps/api` (ADR-007 go/no-go) created a vector index on a scratch collection in the project's **Atlas M0** cluster, ran `$vectorSearch` with a `userId` filter, and deleted the collection. Result: **PASS**. Both of user A's vectors came back in the right order, and user B's near-identical vector was correctly excluded.

- The API creates the index `chunk_vector_index` on the `chunks` collection at startup, and updates it if the vector size changes. The definition is checked in at `apps/api/atlas/vector-index.json`, with filter fields `userId` and `model`.
- `VECTOR_BACKEND=auto` (default) uses Atlas when available and falls back to in-memory cosine search otherwise (local or test MongoDB; fine for under ~5k chunks per user). `atlas` or `memory` forces one.
- Atlas reports cosine scores as (1 + cos) / 2; they are converted back, so both backends rank identically.

## 5. Configuration and running
New variables in `apps/api/.env` (all optional):

| Variable | Default | Meaning |
|---|---|---|
| `EMBEDDING_PROVIDER` | `local` | `local`, `openai` or `fake` |
| `OPENAI_API_KEY` | — | Required when the provider is `openai` |
| `EMBEDDING_MODEL` | provider default | e.g. `text-embedding-3-small` |
| `AI_DAILY_TOKEN_BUDGET` | `200000` | Tokens per user per UTC day (embedding + generation) |
| `VECTOR_BACKEND` | `auto` | `auto`, `atlas` or `memory` |

Run three processes:
```
npm run dev:api      # API on :4000
npm run dev:worker   # background worker (new)
npm run dev:web      # web on :3000
```
On first start, items saved before Phase 3 are queued once, so the worker makes them searchable by meaning.

**API additions**

| Method | Path | Notes |
|---|---|---|
| GET | `/api/search` | `q` (required), `mode=keyword\|semantic\|hybrid` (default hybrid), `type`, `folder=<id\|none>`, `tag`, `limit` (≤ 50) → `{ mode, items: [{ note, score, snippet, matchedBy: keyword\|meaning\|both }], warning? }`. `429 QUOTA_EXCEEDED` or `503 SEMANTIC_UNAVAILABLE` in semantic mode; hybrid falls back to keyword results with a `warning` |
| GET | `/api/search/usage` | Today's `embedTokens`, `genTokens`, `requests` and `budget` |
| POST | `/api/notes/:id/reprocess` | Retry processing for one item (owner only) |

Notes now include `processing: { status: pending\|processing\|ready\|failed\|skipped, updatedAt, error }` and `contentHash`.

**New collections:** `chunks`, `processingJobs`, `usage` (counters expire after 90 days).

## 6. Search evaluation (H2)
`npm run eval:search -w apps/api` loads `apps/api/eval/search/dataset.json` (40 notes on dev, work, research and personal topics) into a throwaway database, embeds it, and runs `queries.json`:
- **20 keyword-style queries**, which use words from the target note.
- **20 paraphrases**, written to avoid the note's words (e.g. "removing greenhouse gases from the atmosphere" → *Carbon capture*).

- **6 off-topic queries** with no matching note (e.g. "volcanic eruptions in Iceland"), to measure noise.

It reports recall@5 and MRR per mode, sweeps the meaning-match threshold, and writes everything, including per-query ranks and failures, to [`docs/eval/phase3.md`](docs/eval/phase3.md).

**Results with the local model** (`all-MiniLM-L6-v2`, threshold 0.25):

| Queries | Keyword recall@5 / MRR | Meaning recall@5 / MRR | Both recall@5 / MRR |
|---|---|---|---|
| All 40 | 70% / 0.67 | **98% / 0.96** | **98%** / 0.84 |
| Keyword-style (20) | 100% / 1.00 | 100% / 1.00 | 100% / 1.00 |
| Paraphrases (20) | 40% / 0.33 | **95% / 0.93** | **95%** / 0.68 |

Off-topic queries return **no results** in any mode. Indexing all 40 notes took 2.0 s, including loading the cached model. Median search latency was 3 ms for keyword, 13 ms for meaning and 14 ms for both (in-memory search on this laptop).

**Threshold tuning.** The cutoff was first set at 0.30 as a guess. The sweep showed that 0.30 drops paraphrase recall to 75%, and 0.15 lets noise in (3 of 6 off-topic queries return results). **0.25** keeps 95% paraphrase recall with zero off-topic results, and shows fewer marginal matches than 0.20 (1.7 vs 2.8 per query). With only 40 notes, re-run the sweep on real data or after any model change.

**Findings**
- **H2 holds on this dataset.** Meaning search more than doubles recall on paraphrases (40% → 95%) without hurting keyword-style queries.
- **Both finds as much as Meaning, but ranks paraphrase matches lower** (MRR 0.68 vs 0.93). Equal-weight rank fusion lets a weak keyword hit outrank the right note: "keeps timing out" matches *Kubernetes probes* through the word "service". Weighting the meaning list higher, or dropping keyword hits that are only one common word, is a candidate Phase 4 improvement. Until then, Meaning is the better mode for questions phrased in your own words.
- **The one miss:** "isolate project dependencies" → *Python virtual environments* (similarity 0.12). The small local model doesn't link the two; OpenAI's larger model likely would.
- **Harness check:** the word-based `fake` embedder scores 0% on paraphrases, which confirms they really avoid the notes' words.

## 7. Tests
`npm test -w apps/api` — **98 tests, all passing.**

| Suite | Tests | Covers |
|---|---|---|
| Phase 1–2 API (`src/test/api.test.ts`) and schema/SSRF unit tests | 60 | Unchanged; all still pass |
| `src/modules/ai-processing/ai-processing.test.ts` | 16 | Chunk sizes, overlap and paragraph boundaries; giant paragraphs; whitespace and boilerplate cleaning; HTML extraction; content-hash change detection; cosine; top-k; reciprocal-rank fusion; retry schedule; fake embedder |
| `src/test/phase3.test.ts` | 22 | Queue on create; no re-queue for pin/tags; empty items skipped; multi-chunk notes; stale results discarded after an edit mid-processing; links to private addresses never fetched; Phase 2 backfill; transient errors retried; backoff → failed after 3 attempts → Retry recovers; reprocess is owner-only; crashed-worker jobs reclaimed; semantic, hybrid and keyword results with snippets; **user B never sees user A's results** in any mode; filters; trash/restore/archive; delete removes chunks; query validation; model outage → 503 / hybrid fallback; usage counters; over-budget 429, hybrid fallback, and no retry |

### Browser tests
Run on the local test stack (Firebase Auth emulator, in-memory MongoDB, API :4100, worker, web :3100), so no real data was touched. UI-P3-01 to 05 used the `fake` embedder; UI-P3-06 used the real local model.

| ID | Steps | Expected | Result |
|---|---|---|---|
| UI-P3-01 | Create a note | Card shows **Processing…**, which clears by itself when the worker finishes (no reload) | ✅ Pass |
| UI-P3-02 | Exhaust the user's daily budget, create a note | Card shows red **Failed** + **Retry**; tooltip "Daily AI budget reached…" | ✅ Pass |
| UI-P3-03 | Restore the budget, click **Retry** | Processing… → ready | ✅ Pass |
| UI-P3-04 | Search, switching Keyword / Meaning / Both | Meaning: "Matched by meaning" + snippet; Both: "meaning and keywords"; Keyword: no label, sorting re-enabled; choice survives a reload | ✅ Pass |
| UI-P3-05 | Over budget: search in Both, then Meaning, then Keyword | Both: keyword results + yellow notice; Meaning: budget error and **no** stale results; Keyword: works normally | ✅ Pass (after fix #1) |
| UI-P3-06 | Real model, 8 notes: search 4 paraphrases and 1 off-topic query in each mode | Meaning finds the right note **at rank 1 for all 4** (*Retry helper*, *Carbon capture*, *Box breathing*, *Roommate bill splitter*), with snippet and "Matched by meaning"; Keyword finds 1 of 4; Both finds all 4 (rank 1–2); off-topic returns nothing | ✅ Pass |

### Bug found in the browser and fixed
1. **A failed search left the previous results on screen.** After switching from Both to Meaning while over budget, the error appeared, but the old results and their notice stayed, so it looked as if Meaning had found them. Results are now cleared when a *different* search fails; a failed background refresh of the same view still keeps the list.

Also fixed: the search-mode buttons now carry explicit accessible names ("Keyword", "Meaning", "Both") instead of relying on their tooltips.

## 8. Not in Phase 3
- Answers generated from your notes (RAG) and `ai-client.generate()` arrive in Phase 4; the entry point exists and throws until then.
- Re-ranking with a cross-encoder, and per-folder or date filters inside Atlas (filters are applied after vector search, which is fine at this scale).

## 9. Possible next steps
- **Hybrid ranking:** weight meaning results above weak keyword hits (see the findings in section 6).
- **OpenAI embeddings:** with a key, run `EMBEDDING_PROVIDER=openai npm run eval:search -w apps/api` to compare quality against the local model, and tune `MIN_SIMILARITY.openai` from its sweep.
- **Windows runtime:** once every dev machine has Visual C++ 14.40+, remove the two npm overrides (section 3).
