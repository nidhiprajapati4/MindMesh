# MindMesh AI — Phase 6: Connections & graph

Status: **Implementation complete, and free.** Everything runs on the local embedding model MindMesh already uses (`Xenova/all-MiniLM-L6-v2`): no API key, no paid service, no new model. The one new library is `d3-force` (MIT), which lays out the graph.

172 automated API tests pass (152 from Phases 1–5, 20 new), and 10 browser scenarios passed on a local test stack with the real local model. Settings were tuned on a free evaluation ([docs/eval/phase6.md](docs/eval/phase6.md)). Building and testing found and fixed 4 problems, one of them from Phase 3 (section 6). Every scenario is listed in [phase6_Test_Scenarios.md](phase6_Test_Scenarios.md).

## 1. What Phase 6 adds
| Feature | Details |
|---|---|
| **Note links** | Write `[[Note title]]` in a note to link to another note. Typing `[[` suggests titles; Enter or Tab inserts one, Esc closes the list |
| **Links panel** | In the editor: **Links to** (click to open) and **Linked from** (backlinks). A link to a note that doesn't exist yet says "not created yet · **Create it**" |
| **Link from Related notes** | Each related note (Phase 5) has a **Link** button that adds `[[Title]]` to the note |
| **Links on cards** | `[[Title]]` shows as a clickable link on note cards, and cards show how many notes link to them |
| **Rename keeps links** | Renaming a note rewrites `[[Old title]]` to `[[New title]]` in the notes linking to it, without marking them as edited |
| **Graph** | Sidebar → *Graph of your notes*: notes as dots, links as solid lines, similar meaning as dashed lines. Hover shows a title and highlights its connections; click opens the note; zoom, pan and drag. Filter by folder, tag and type; colour by topic, folder or type; search to centre a note |
| **List view** | The same notes and connections as text, grouped by topic. The default on phones, and the accessible version of the graph |
| **Topics** | Groups of related notes found automatically, with a name (a shared tag, or shared title words) |
| **Unconnected notes** | Notes with no link and nothing similar: good ones to link, tag or tidy away |

## 2. How it works
```
save a note ─► parse [[links]] (not in code blocks or snippets) ─► match titles ─► note.outLinks
             ─► links waiting for this title now lead to it; a rename rewrites the links to it

graph / topics ─► the user's library: active notes, their links, every pair ≥ 0.30 similar
                  (note vectors from Phase 5; rebuilt only when a note is edited, added,
                   removed or processed)
               ─► similar lines: each note's 3 closest notes at ≥ 0.40
               ─► topics: connections added strongest first, groups capped at 40 notes
```
- **Links match by title**, ignoring case and spacing (`[[retry   HELPER]]` finds "Retry helper"). If several notes share a title, the link goes to the most recently updated one. A link only ever reaches the same user's notes.
- **Links to notes that don't exist yet** are kept and start working when a note with that title is created, restored or renamed to it.
- **Trash:** a trashed note disappears from backlinks and the graph; a link to it says "in the trash". Restoring brings everything back. Deleting forever leaves links waiting for a new note with that title.
- **Topics** are single-linkage clusters with a size cap. Notes join a topic at 0.40 similarity. A `[[link]]` lowers that bar to 0.30 but never joins notes with nothing in common, so a hub note (a weekend plan, an index) can't merge unrelated topics. Groups smaller than 3 notes aren't topics.
- **Names:** the most common tag if at least half the topic uses it. Otherwise up to two title words shared by at least a third of the topic, picked by how typical they are of this topic compared with the whole library.
- **Nothing is stored for the graph or topics.** They are computed on request and cached per user until a note changes.
- **The graph is laid out once, up front,** and fitted to the screen, then drawn on a canvas, so it stays quick with hundreds of notes and doesn't stall in background tabs.
- **Existing notes need nothing.** At startup the API gives notes saved before Phase 6 their title key and links.

## 3. Settings
In `apps/api/src/modules/connections/`, tuned on the evaluation (section 5).

| Setting | Value | Why |
|---|---|---|
| `similarMin` | 0.40 | 95% of notes on a known subject connect to it, with 3% unrelated lines; 0.45 connected only 76% |
| `similarPerNote` | 3 | Keeps the graph readable |
| `topicMin` | 0.40 | Recovered 90% of known subjects (0.45: 86%, 0.50: 58%); at 0.45 real 4-note topics fell apart into pairs |
| `linkedMin` / `linkBonus` | 0.30 / 0.15 | Links help similar-enough notes group, without letting hub notes merge topics |
| `maxSize` / `minSize` | 40 / 3 | One loose chain can't swallow the library; pairs aren't topics |
| Graph / library size | 500 / 1,500 notes | Most recently updated first; filters show the others |

## 4. API
All require sign-in and only ever return the user's own notes.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/connections/links/:id` | `{ outgoing: [{ title, note: brief \| null, state: "ok" \| "missing" \| "trashed" }], backlinks: [brief] }`. `404` for another user's or a trashed note |
| GET | `/api/connections/graph` | Query `folder` (id or `none`), `tag`, `type`, `similar` (`1`/`0`, default `1`) → `{ nodes: [{ id, title, type, folderId, tags, topicId, degree }], edges: [{ source, target, kind: "link" \| "similar", similar }], capped, total }`. A linked pair that is also similar is one `link` edge carrying its similarity |
| GET | `/api/connections/topics` | `{ topics: [{ id, name, noteIds, size }], unconnected: [{ _id, title, type }], unconnectedCount, capped }` |

Changed: `GET /api/notes` items now include `backlinkCount`, and notes include `outLinks: [{ key, title, noteId }]`.

Data changes: notes get `titleKey` (normalised title) and `outLinks`, with indexes `{ userId, titleKey }` and `{ userId, outLinks.noteId }`.

## 5. Evaluation
`npm run eval:connections -w apps/api` (free, local model) writes [`docs/eval/phase6.md`](docs/eval/phase6.md). It uses 64 notes: the Phase 3 dataset (40), 8 reworded copies, and 4 topics of 4 notes from the Phase 5 eval. The known subjects are baking, running, Kubernetes and money (each dense topic plus the dataset note on that subject), and each copy with its original.

| What | Result |
|---|---|
| Similar lines joining notes on the same topic | **91%** (6% loosely related, **3% unrelated**: one line, *Interval session* to *Load testing with k6*) |
| Known-subject notes connected to their subject | **95%** |
| Known subjects recovered as topics (average F1) | **90%** (baking 80%, running 91%, Kubernetes 100%, money 89%) |
| Topic purity (notes in their topic's main area) | **96%** |
| Topics found | 5: running, kubernetes, investing, baking, and an auth/backend group named "helper · jwt" |

## 6. Problems found and fixed
1. **A hub note merged unrelated topics.** Seeding the browser test library, a "Weekend plan" note linking to a baking note and a running note glued them into one topic, because links counted as the strongest connection. Now a link only lowers the bar for notes that are already somewhat similar (test TOPIC-03).
2. **Background processing changed a note's "updated" time (since Phase 3).** The worker's status writes let the database bump `updatedAt`. So re-processing reshuffled "Recently updated" without any edit: after a rename rewrote links, and for every note after `npm run reembed`. The worker's own writes now leave the time alone (test LINK-06), and the graph cache watches note vectors to notice finished processing.
3. **The graph layout stalled in background tabs**, because the animation timer pauses there. The layout is now computed up front and fitted to the canvas.
4. **Topic names used a word from only one note** ("kubernetes · deploys"). Name words must now be shared by at least 2 notes and a third of the topic (test TOPIC-01).

Also tuned from the eval: similar lines 0.45 → 0.40 and topics 0.50 → 0.40.

## 7. Limits
- **Links follow titles.** Two notes with the same title can't both be linked by `[[Title]]`; the link goes to the most recently updated one.
- **Renaming rewrites every matching `[[Old title]]`** in the linking notes, including inside code blocks.
- **The Links panel reflects the saved note.** Links you have just typed appear there after saving.
- **Similarity isn't topic.** At 0.40 the eval had one unrelated line, and "Load testing with k6" joined the running topic, because both talk about pace and intervals.
- **Topics need a few similar notes.** Notes on one-off subjects stay "Not in a topic" (27 of the eval's 64 notes are unconnected).
- **Size:** the graph draws your 500 most recently updated notes (filters show others), and topics consider the 1,500 most recent. The page says when it hits a cap.
- **Archived notes** are not in the graph or topics, but links to and from them still show in the Links panel.

## 8. Run it
Nothing new to configure. Install the new web dependency, then run the API, worker and web app as before:
```bash
npm install
```
```bash
npm run dev:api
```
```bash
npm run dev:worker
```
```bash
npm run dev:web
```
On first start the API prepares existing notes for links. The graph uses the note vectors from Phase 5, so notes need to be processed (no "Processing…" badge) before they show similar connections.
