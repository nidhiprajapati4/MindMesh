# Phase 6 test scenarios: Connections & graph

Every Phase 6 test scenario: what it checks, how to run it, and its latest result. Feature details are in [phase6_Readme.md](phase6_Readme.md).

| Kind | Scenarios | Latest result |
|---|---|---|
| Automated API tests (Phase 6) | 20 | ✅ 20 / 20 pass (whole suite: 172 / 172) |
| Manual browser scenarios | 10 | ✅ 10 / 10 pass |
| Free connections evaluation | 64 notes, 4 known subjects | ✅ 95% of subject notes connected; 90% of subjects found as topics; 1 unrelated line |

## How to run

**Automated tests** (in-memory database; fake embedding model; no network, no cost):
```bash
npm test -w apps/api
```

**Manual browser scenarios:** run the three dev processes and open http://localhost:3000.
```bash
npm run dev:api
```
```bash
npm run dev:worker
```
```bash
npm run dev:web
```
Set up a small library first, and wait until no card says "Processing…":
- folders **Kitchen** (4 baking notes), **Platform** (4 Kubernetes notes) and **Training** (4 running notes, including "Easy run pace" and "Long run fuelling"), each tagged
- a note **Weekend plan**: `Saturday: bake using [[Sourdough hydration]], then an [[Easy run pace]] loop. Sunday: make the [[Picnic menu]].`
- an idea **Volcano trip** about something unrelated

**Evaluation** (free, local model):
```bash
npm run eval:connections -w apps/api
```
It writes [docs/eval/phase6.md](docs/eval/phase6.md).

---

## 1. Automated: links (`src/test/phase6.test.ts`)
| ID | Scenario | Expected | Result |
|---|---|---|---|
| LINK-01 | Text with repeated, oddly spaced and bracketed links, code blocks and inline code; a snippet | Each title once; nothing from code; snippets have no links | ✅ |
| LINK-02 | 150 links; a link split across lines | At most 100 kept; split link ignored | ✅ |
| LINK-03 | `[[retry   HELPER]]` with a note "Retry helper" | Resolves to it; shows as its backlink | ✅ |
| LINK-04 | Link to "Circuit breaker" before any such note; then the note is created | "missing" at first; then leads to the new note, which lists the backlink | ✅ |
| LINK-05 | Two notes titled "Weekly plan" | The link goes to the most recently updated | ✅ |
| LINK-06 | A linked note is renamed | Linking text becomes `[[Release checklist]]`; link kept; linking note's updated time unchanged, also after the worker re-processes it; a new note with the old title doesn't take the link | ✅ |
| LINK-07 | Link removed, re-added, tags edited, type changed to snippet | Backlink goes, comes back, survives a tag edit, goes for a snippet | ✅ |
| LINK-08 | Source trashed/restored; target trashed/restored; target deleted forever, then recreated | Backlink hidden then back; link "trashed" then "ok"; dangling after delete; picked up by the new note | ✅ |
| LINK-09 | Notes list | `backlinkCount` matches the backlinks | ✅ |
| LINK-10 | `[[B secret plan]]` written by user A; other user's requests; bad id; no sign-in | Link stays "missing" (never reaches B's note); `404`; `400`; `401` | ✅ |
| LINK-11 | Notes saved before Phase 6 (no title key, no links) | Startup backfill adds both; running it again changes nothing | ✅ |

## 2. Automated: graph
| ID | Scenario | Expected | Result |
|---|---|---|---|
| GRAPH-01 | Two similar, linked bread notes; a note linking to one of them; an unrelated note; a trashed note; another user's note | Only this user's active notes; a linked and similar pair is one `link` edge with its similarity; the unrelated note has no edges; degrees counted | ✅ |
| GRAPH-02 | `?tag=`, `?type=`, `?folder=none`, `?similar=0` | Only matching notes; links only | ✅ |
| GRAPH-03 | A new note linking to another; then trashed | Appears with its link; then gone with its edges | ✅ |
| GRAPH-04 | Another user; bad folder, type or parameter; no sign-in | Sees only their own note; `400`; `401` | ✅ |
| GRAPH-05 | Four notes along a line, keeping 1 or 3 per note; a subset | Only each note's closest; only included notes | ✅ |

## 3. Automated: topics
| ID | Scenario | Expected | Result |
|---|---|---|---|
| TOPIC-01 | 4 baking notes (3 tagged), 3 Kubernetes notes (untagged), a pair, an unprocessed note | Topics "baking" (4) and "kubernetes" (3); the pair isn't a topic; the unprocessed note is unconnected | ✅ |
| TOPIC-02 | A chain of 12 similar notes, size cap 4 | Several topics of 3–4 notes | ✅ |
| TOPIC-03 | A hub linking to two notes 0.35 similar to it; an index linking to two unrelated notes | Hub and its notes form a topic (not without the links); the index doesn't merge its unrelated notes | ✅ |
| TOPIC-04 | Topics endpoint vs graph; the unconnected note gains a link; another user; no sign-in | Same topic ids in both; the note is no longer unconnected, but a link alone doesn't pull it into the topic; private; `401` | ✅ |

## 4. Manual browser scenarios
Run on 2026-10-27 on a local test stack (in-memory MongoDB, Firebase Auth emulator, real local model) with the library above.

| ID | Steps | Expected | Result |
|---|---|---|---|
| UI-01 | Open "Easy run pace", type ` Also [[Inter` at the end, press Enter | A list offers "Interval session" (not the note itself); Enter inserts `[[Interval session]]` with the cursor after it | ✅ |
| UI-02 | Type ` [[`, then Esc | Recent notes listed; Esc closes the list but not the editor | ✅ |
| UI-03 | Notes list: the Weekend plan card; click "Easy run pace" in it | Links shown without brackets (Picnic menu not clickable: no such note); the Easy run pace card shows 1 link; clicking opens that note | ✅ |
| UI-04 | Editor of Easy run pace | **Linked from:** Weekend plan; Related notes list running notes with **Link** buttons | ✅ |
| UI-05 | Click **Link** next to "Long run fuelling", save | `[[Long run fuelling]]` added; the button shows "Linked"; the card shows both new links | ✅ |
| UI-06 | Editor of Weekend plan → "Picnic menu · not created yet · **Create it**" | A note "Picnic menu" is created and opened, showing **Linked from:** Weekend plan | ✅ |
| UI-07 | Rename "Picnic menu" to "Picnic food", save | Weekend plan now reads `[[Picnic food]]` and the link still works. *First run:* Weekend plan also jumped to the top of "Recently updated" once re-processed; fixed, and covered by LINK-06 | ✅ |
| UI-08 | Sidebar → Graph of your notes, Graph view; hover a Kubernetes dot; click it | Separate clusters per topic, laid out and fitted; hover shows "Pod resource limits · click to open", its neighbours' titles, dims the rest; click opens the note | ✅ |
| UI-09 | Tag filter `#running`; colour by Folder; List view; Unconnected notes | Only running notes; legend Training / Platform / Kitchen / Unfiled; list grouped by topic with each note's connections ("linked · 54% similar"); "Volcano trip" unconnected | ✅ |
| UI-10 | Phone width (375 px): graph page, graph view, editor with Links panel | List view by default; graph fits the width; editor fits; no sideways scrolling | ✅ |

During the runs all API requests succeeded, the browser console had no errors, and the API, worker and web logs had no errors. Not exercised in the browser: the graph's search box and dragging dots (the code paths are simple; worth a look on first use).
