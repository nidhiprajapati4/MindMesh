# Phase 5 test scenarios: Smart organization

Every Phase 5 test scenario: what it checks, how to run it, and its latest result. Feature details are in [phase5_Readme.md](phase5_Readme.md).

| Kind | Scenarios | Latest result |
|---|---|---|
| Automated API tests (Phase 5) | 16 | ✅ 16 / 16 pass (whole suite: 152 / 152) |
| Manual browser scenarios | 9 | ✅ 9 / 9 pass |
| Free organization evaluation | 40 + 16 notes, 8 copies, 3 long notes | ✅ 100% duplicates caught; 100% tag and folder precision; 63% key facts |

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
- folder **Kitchen** with 3 notes tagged `baking` (sourdough hydration, proofing overnight, baking in a Dutch oven)
- folder **Platform** with 3 notes tagged `kubernetes` (pod resource limits, rolling deployments, CrashLoopBackOff)
- one long **Document** of 8+ sentences (for example a project retrospective)

**Evaluation** (free, local model):
```bash
npm run eval:organize -w apps/api
```
It writes [docs/eval/phase5.md](docs/eval/phase5.md).

---

## 1. Automated: note vectors and ranking
| ID | Scenario | Expected | Result |
|---|---|---|---|
| RANK-06 | Average of chunk vectors | Unit length; a single vector is just normalised | ✅ |
| ORG-01 | Note processed, trashed, deleted, restored | Note vector written; removed on trash and permanent delete; rebuilt on restore | ✅ |
| ORG-02 | Notes processed before Phase 5 | The startup backfill builds their note vector from the stored chunks; running it again builds nothing | ✅ |

## 2. Automated: related notes (`GET /api/organize/related/:id`)
| ID | Scenario | Expected | Result |
|---|---|---|---|
| ORG-03 | Note with similar and unrelated notes, plus another user's similar note | Similar notes listed with a preview (no vectors sent); never the note itself, unrelated notes or the other user's note | ✅ |
| ORG-04 | Trashed similar note; restored but not yet processed note; other user; bad id; no sign-in | Trashed note not listed; unprocessed note returns `pending: true`; other user `404`; bad id `400`; no sign-in `401` | ✅ |

## 3. Automated: suggestions (`POST /api/organize/suggest`)
| ID | Scenario | Expected | Result |
|---|---|---|---|
| ORG-05 | Draft like several notes tagged and filed alike | Suggests their tag and their folder | ✅ |
| ORG-05b | Similar notes unfiled, or split between folders | Unfiled notes don't outvote the folder; a split vote gives no folder | ✅ |
| ORG-06 | Draft already has the tag, or a folder chosen | That tag isn't suggested; no folder suggestion | ✅ |
| ORG-07 | Draft unlike anything saved, or under 20 characters | No tags, no folder, no duplicates | ✅ |
| ORG-08 | Another user has notes like the draft | Their tags and folders are never suggested | ✅ |
| ORG-09 | Near-copy of a saved note; then editing that note itself | Copy flagged as `similar`; a note is never its own duplicate (`noteId`) | ✅ |
| ORG-10 | Link saved as `https://www.example.com/article/`, draft with `http://example.com/article#top` | Flagged as `same-link` (scheme, `www.`, trailing slash and `#fragment` ignored) | ✅ |

## 4. Automated: duplicates view, key points, validation
| ID | Scenario | Expected | Result |
|---|---|---|---|
| ORG-11 | Near-copy and a repeated link; another user; copy moved to trash | Both pairs listed (`similar`, `same-link`); another user never sees them; trashed copy no longer listed | ✅ |
| ORG-12 | 6-sentence note and 2-sentence note | Long note gets 2–3 sentences, each one of its own; short note gets none | ✅ |
| ORG-13 | Only tags edited, then text shortened | Tag edit doesn't re-process the note; after the text change the key points are recomputed (now none) | ✅ |
| ORG-14 | Bad input, no sign-in, user over the daily budget | `400` for unknown fields, a title over 200 characters or a bad `noteId`; `401` without sign-in; `429 QUOTA_EXCEEDED` when over budget | ✅ |

## 5. Manual browser scenarios
Run on 2026-10-27 on a local test stack (in-memory MongoDB, Firebase Auth emulator, real local model) with the library above.

| ID | Steps | Expected | Result |
|---|---|---|---|
| UI-01 | Look at the long document's card | **Key points** list (3 of its sentences) instead of the first lines | ✅ |
| UI-02 | New item → title "Scoring the loaf", text about scoring a proofed sourdough loaf before the Dutch oven; stop typing | After about a second: **Suggested: + #baking** and **Move to Kitchen** | ✅ |
| UI-03 | Click **+ #baking**, then **Move to Kitchen**; save | Tags field gets `baking`, chip disappears; folder becomes Kitchen; note saved in Kitchen | ✅ |
| UI-04 | New item, reworded copy of "Pod resource limits" | Yellow notice: "This looks like **Pod resource limits** (98% similar). Open it · or keep editing and save anyway." | ✅ |
| UI-05 | Click **Open it**, confirm discarding the draft | Editor switches to "Pod resource limits" | ✅ |
| UI-06 | In the open note, look under the text | **Related notes**: the other Kubernetes notes; no baking notes | ✅ |
| UI-07 | Write the copy again, press Ctrl+Enter while the warning shows | Saved anyway; never blocked | ✅ |
| UI-08 | Sidebar → **Find possible duplicates**; **Move to trash** on the copy | Pair shown side by side at 98%; after trashing: "Moved … to the trash", then "No likely duplicates found among your 8 notes." | ✅ |
| UI-09 | Phone width (375 px): notes page, editor with key points, duplicates page | Everything fits; no sideways scrolling | ✅ |

During the run all API requests succeeded, and the API, worker and web logs had no errors.
