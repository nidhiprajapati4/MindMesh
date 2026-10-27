# MindMesh AI — Phase 5: Smart organization

Status: **Implementation complete, and free.** Everything runs on the local embedding model MindMesh already uses for search (`Xenova/all-MiniLM-L6-v2`): no API key, no new paid service, no new model download. Nothing is changed automatically; every suggestion is one click to accept and easy to ignore.

152 automated API tests pass (136 from Phases 1–4, 16 new), and 9 browser scenarios passed on a local test stack with the real local model. Every setting was tuned on a free evaluation ([docs/eval/phase5.md](docs/eval/phase5.md)). Every test scenario is listed in [phase5_Test_Scenarios.md](phase5_Test_Scenarios.md).

## 1. What Phase 5 adds
| Feature | Details |
|---|---|
| **Related notes** | Opening a saved note shows up to 5 of your other notes most similar to it. Click one to open it |
| **Tag suggestions** | While you write, **Suggested: + #baking** chips appear under the tags field, learned from how *your* similar notes are tagged. Click to add |
| **Folder suggestions** | For an unfiled draft, **Move to Kitchen** appears when your similar, filed notes clearly agree on one folder |
| **Duplicate warning** | "This looks like *Pod resource limits* (98% similar). Open it · or keep editing and save anyway." Also for a link you saved before, however the URL is written. Saving is never blocked |
| **Possible duplicates** | A page (sidebar → *Find possible duplicates*) listing likely duplicate pairs side by side, with Open and Move to trash for either note |
| **Key points** | Long notes, uploaded documents and saved links get 2–3 of their own sentences that best sum them up. Shown on the card (instead of the first lines) and at the top of the editor |

## 2. How it works
```
worker, after embedding a note's chunks
   ├─► note vector = normalised average of the chunk vectors ─► `noteVectors` collection
   └─► key points  = 2–3 sentences picked by MMR (below) ─────► note.keyPoints

related notes  ─► nearest note vectors of the same user (Atlas Vector Search or in memory)
suggestions    ─► embed the draft like the worker does ─► 10 nearest notes ─► similarity-weighted votes
duplicates     ─► same link, or note vectors at least 0.90 similar
```
- **A vector per note.** Phase 3 stores one embedding per chunk. Phase 5 adds one per note, kept in its own `noteVectors` collection (indexed `note_vector_index` on Atlas). It is removed when a note is trashed or emptied and rebuilt on restore, and is never sent to the browser.
- **Existing notes need no re-embedding.** At startup the API builds missing note vectors from the chunks already stored. `npm run reembed` also clears note vectors of an old model.
- **Only your own notes** are ever compared, with the same owner, trash and archive checks as search. Suggestions never learn from another user's notes.
- **Tags** are votes from the 10 nearest notes that are at least 0.35 similar. A tag is suggested if **2 or more** neighbours use it, or **one** neighbour at least 0.70 similar does. At most 3, never one the draft already has.
- **Folders** are suggested only for unfiled drafts. Only *filed* neighbours vote (unfiled notes are usually just not organised yet); at least 2 must agree, holding 60% of the vote.
- **Suggestions are fetched after you stop typing** (800 ms), only for drafts of 20+ characters or with a link. Editing never waits for them. Each request embeds the draft, which counts against the daily AI budget, but is free with the local model.
- **Key points** use maximal marginal relevance (MMR): each sentence scores by how close it is to the whole note, minus how much it repeats a sentence already picked. Notes with fewer than 4 sentences get none (they're short enough to read); 8+ sentences get 3, otherwise 2. Shown in their original order. They are recomputed only when the text changes (the Phase 3 content hash), not when only tags or the folder change.

## 3. Settings
All in `apps/api/src/modules/organize/` and tuned on the evaluation (section 5).

| Setting | Value | Why |
|---|---|---|
| `relatedMin` | 0.35 | About twice as many notes get related notes as at 0.45, at the best same-topic share; 0.30 let unrelated notes in |
| `tagNeighbourMin` | 0.35 | 63% tag hit rate with no wrong tags on a library with several notes per topic; silent on one-off topics. 0.30 started suggesting wrong folders |
| `tagMinVotes` | 2 | 1 vote made wrong suggestions (14–50% precision) |
| `tagStrongSim` | 0.70 | One very close neighbour is enough |
| `folderMinShare` | 0.60 | Neighbours split between folders give no suggestion |
| `duplicateMin` | 0.90 | Caught all 8 reworded copies; 0.92 missed 2 |
| Key points `diversity` | 0.5 | Covered 63% of key facts vs 50% at 0.7–0.8 |

## 4. API
All require sign-in. Mounted under `/api/organize` (not `/api/notes`, so they can't clash with `/api/notes/:id`).

| Method | Path | Notes |
|---|---|---|
| GET | `/api/organize/related/:id` | `{ items: [{ note: { _id, title, type, preview }, score }], pending }`. `pending: true` while the note hasn't been processed yet. `404` for someone else's or a trashed note |
| POST | `/api/organize/suggest` | `{ title, content, sourceUrl?, tags, folderId?, noteId? }` → `{ tags: [{ tag, score }], folder: { _id, name, score } \| null, duplicates: [{ _id, title, type, preview, score, reason: "similar" \| "same-link" }] }`. `noteId` excludes the note being edited. `400` validation, `429` `QUOTA_EXCEEDED` |
| GET | `/api/organize/duplicates` | `{ pairs: [{ a, b, score, reason }], scanned, capped }`: up to 50 pairs among your 1,500 most recently updated notes |

Data changes: new collection `noteVectors` `{ userId, noteId (unique), embedding, model, dims }`; notes get `keyPoints: string[]`.

## 5. Evaluation
`npm run eval:organize -w apps/api` (free, local model) writes [`docs/eval/phase5.md`](docs/eval/phase5.md). It uses the 40-note Phase 3 dataset with its tags, filed into topic folders, plus `eval/organize/extra.json`: 8 reworded near-copies, a denser set (4 topics × 4 notes) and 3 long notes with their key facts. Suggestions are scored leave-one-out: each note is treated as a fresh draft, with its own tags and folder hidden.

| What | Result |
|---|---|
| Duplicates: warned while writing a reworded copy | **100%** (8 / 8) |
| Duplicates: copies found on the duplicates page | **100%**, 1 false alarm (two notes about the same database outage, 92% similar) |
| Tags, denser library: correct tag suggested / suggestions correct | **63%** / **100%** |
| Folders, denser library: suggested / correct | **63%** / **100%** |
| Tags, library of one-off topics: wrong suggestions | **none** (quiet 100% of the time) |
| Related notes: on the same topic | 50%, for the 25% of notes that have any |
| Key points: key facts covered | **63%** |

## 6. Problems found and fixed while building
1. **Folder suggestions never appeared** when some similar notes were unfiled, because unfiled notes voted for "no folder". Now only filed notes vote (test ORG-05b also checks that a split vote gives no suggestion).
2. **Tag and folder suggestions almost never fired** at the first thresholds (0.45), and related notes were too strict. Tuned to 0.35 from the sweeps; a denser evaluation set was added to prove suggestions work when there is something to learn from.
3. **Key points repeated each other** at diversity 0.7 (50% of facts covered); 0.5 covers 63%.
4. **The "Moved to the trash" message on the duplicates page never went away** (it relied on an animation event that never fired). It now clears after a few seconds.

## 7. Limits
- **Suggestions need examples.** With one note per topic there is nothing to learn from, so MindMesh stays quiet rather than guess (the eval's main set: 0% hit rate, 100% precision). They appear once you have a few similar, tagged or filed notes.
- **Duplicate means "says nearly the same thing".** Two genuinely different notes about the same event can look like copies (the one false alarm). Nothing is deleted automatically.
- **Key points are extractive:** they quote the note's own sentences, so they can't merge or rephrase facts. On the eval they caught 63% of key facts.
- **The duplicates page** compares your 1,500 most recently updated notes and shows at most 50 pairs; the page says when it hit the cap.
- **English-tuned.** The local model and sentence splitting work best on English text.

## 8. Run it
Nothing new to configure. Run the API, worker and web app as before:
```bash
npm run dev:api
```
```bash
npm run dev:worker
```
```bash
npm run dev:web
```
On first start the API builds note vectors for notes you already have. Key points for existing long notes appear the next time they are edited, or for all of them after `npm run reembed -w apps/api`.
