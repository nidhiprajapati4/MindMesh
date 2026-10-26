# MindMesh AI — Phase 2: Organize, search, capture, upload

Status: **Implemented and tested.** 60 automated API tests pass, and all 20 UI scenarios plus 3 extra checks (section 5) passed in a real browser against a local test stack. 9 bugs were found and fixed along the way.

## 1. What Phase 2 adds
| Spec ID | Feature | Details |
|---|---|---|
| FR-05 | Item types | `note`, `snippet`, `url` (link), `idea`, `document` |
| FR-07 | Folders | Create, **rename** (✎ button or double-click), delete (items are kept and become unfiled), item counts, case-insensitive unique names |
| FR-07 | Metadata | Editable: `language` (snippets), `siteName`, `description`, `author`. Server-set for uploads: `fileName`, `fileSize`, `mimeType`, `pageCount`, `truncated` |
| FR-08 | Keyword search and filters | Ranked full-text search with a partial-word fallback; filter by type, folder, unfiled, tag, pinned, date range; sort by updated / created / title / best match; "Load more" |
| FR-09 | URL capture | Paste a link; the server fetches the title and description. Private and loopback addresses are blocked, redirects are re-checked, with a 5 s timeout and a 512 KB cap |
| FR-09 | **File upload** | `.pdf`, `.docx`, `.md`, `.txt`, up to 10 MB. Text is extracted into a new `document` item; **the file itself is not stored**. Content is checked against the file extension |
| — | Trash | Delete moves an item to Trash (with an Undo toast); restore, delete forever, empty trash; auto-purge after 30 days |
| — | Popup editor | Create and **Edit** open in a modal dialog with Write / Upload file tabs; Esc and Cancel ask before discarding changes |
| — | Sidebar | Sections (Views, Type, Folders, Tags) separated by horizontal lines; New item and Upload file buttons |
| H1 | Fast capture | `N` new item, `/` search, `Ctrl/⌘+Enter` save, `Esc` close |

## 2. API
All `/api/*` routes need `Authorization: Bearer <Firebase ID token>`.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/notes` | `q, type, folder=<id\|none>, tag, pinned, view=active\|archived\|trash, from, to, sort=updated\|created\|title\|relevance, page, limit` → `{ items, total, page, limit, matchMode }` |
| GET | `/api/notes/tags` | Tags on active items |
| POST | `/api/notes` | Create |
| GET / PATCH | `/api/notes/:id` | Read / edit (metadata merges field by field; `""` clears a field) |
| POST | `/api/notes/upload` | `multipart/form-data`: `file` (required), `folderId`, `tags` (comma-separated) |
| POST | `/api/notes/capture-url` | `{ url, folderId?, tags? }` |
| DELETE | `/api/notes/:id` | Move to trash |
| POST | `/api/notes/:id/restore` | Restore from trash |
| DELETE | `/api/notes/:id/permanent` | Trashed items only |
| DELETE | `/api/notes/trash` | Empty trash |
| GET / POST | `/api/folders` | List (with counts) / create |
| PATCH / DELETE | `/api/folders/:id` | Rename / delete |

Upload errors: 400 no file, 413 over 10 MB, 415 unsupported type or content doesn't match the extension, 422 empty/unreadable file or image-only PDF.

## 3. Run it
```bash
npm install
npm run dev:api
npm run dev:web
```
On startup the API backfills old notes to the Phase 2 shape and syncs indexes (this replaces the text index with `note_text_v2`).

## 4. Automated tests: 60 scenarios, all passing
```bash
npm test -w apps/api
```
These run the real Express app against a throwaway in-memory MongoDB (`mongodb-memory-server`). Auth uses emulator-style test tokens, so your Firebase project and Atlas data are never touched. The first run downloads a MongoDB binary (~65 MB).

| ID | Scenario | Result |
|---|---|---|
| AUTH-01 | Requests without a token get 401 | ✅ Pass |
| AUTH-02 | Malformed / wrong-project tokens get 401 | ✅ Pass |
| AUTH-03 | `/health` and `/api/me` work | ✅ Pass |
| NOTE-01 | Create note with Phase 2 defaults | ✅ Pass |
| NOTE-02 | All 5 item types can be created | ✅ Pass |
| NOTE-03 | Tags lowercased, trimmed, de-duplicated | ✅ Pass |
| NOTE-04 | Invalid input rejected (long title, bad type, `javascript:` URL, client-set owner, client-set file metadata, >20 tags) | ✅ Pass |
| NOTE-05 | Malformed JSON → 400; bad id → 400; unknown id → 404 | ✅ Pass |
| NOTE-06 | Edit title, content, type, tags, source URL; clear source URL | ✅ Pass |
| NOTE-07 | Edit metadata per field; empty string clears | ✅ Pass |
| NOTE-08 | Pin and archive; archived hidden from the main list | ✅ Pass |
| ISO-01 | User B cannot read / edit / trash / restore / delete A's note | ✅ Pass |
| ISO-02 | Lists, search, tags, folders and empty-trash never cross users | ✅ Pass |
| ISO-03 | User B cannot use / rename / delete A's folder | ✅ Pass |
| FOLD-01 | Create folders; alphabetical list with counts | ✅ Pass |
| FOLD-02 | Duplicate names rejected (case-insensitive); empty/long names rejected | ✅ Pass |
| FOLD-03 | Rename folder; renaming to an existing name rejected | ✅ Pass |
| FOLD-04 | Deleting a folder keeps its items as unfiled | ✅ Pass |
| FOLD-05 | Move an item between folders and to unfiled | ✅ Pass |
| SRCH-01 | Full-text search ranks title matches first | ✅ Pass |
| SRCH-02 | Searches content; stemming (recipes → recipe) | ✅ Pass |
| SRCH-03 | Partial-word fallback ("retr"); regex characters escaped | ✅ Pass |
| SRCH-04 | Filter by type, folder, unfiled, tag, pinned; filters combine with search | ✅ Pass |
| SRCH-05 | Pinned first; title sort is case-insensitive | ✅ Pass |
| SRCH-06 | Pagination; limit capped at 100 | ✅ Pass |
| SRCH-07 | Date-range filter | ✅ Pass |
| SRCH-08 | Tag list sorted; excludes trashed items | ✅ Pass |
| TRASH-01 | Delete → trash → restore | ✅ Pass |
| TRASH-02 | Trashed items can't be edited or trashed again | ✅ Pass |
| TRASH-03 | Permanent delete only from trash | ✅ Pass |
| TRASH-04 | Empty trash removes only trashed items | ✅ Pass |
| TRASH-05 | Trashing unpins | ✅ Pass |
| UPL-01 | `.txt` upload → document item with file details | ✅ Pass |
| UPL-02 | `.md` uses the first `# heading` as title | ✅ Pass |
| UPL-03 | `.pdf` text extracted, page count recorded | ✅ Pass |
| UPL-04 | `.docx` text extracted | ✅ Pass |
| UPL-05 | Uploaded text is searchable | ✅ Pass |
| UPL-06 | Folder and tags on upload; can't upload into another user's folder | ✅ Pass |
| UPL-07 | Unsupported types and disguised files rejected (415) | ✅ Pass |
| UPL-08 | Empty, blank, broken and >10 MB files rejected | ✅ Pass |
| UPL-09 | Missing file / wrong field / no token rejected | ✅ Pass |
| UPL-10 | Non-ASCII file names preserved | ✅ Pass |
| UPL-11 | Text over 50,000 characters is cut off and flagged | ✅ Pass |
| UPL-12 | Editing an uploaded document keeps its file details | ✅ Pass |
| CAP-01 | Private / cloud-metadata addresses are not fetched (link still saved) | ✅ Pass |
| CAP-02 | Non-http URLs rejected | ✅ Pass |
| (unit) | 14 schema, SSRF-guard and HTML-metadata unit tests | ✅ Pass |

### Bugs these tests found and fixed
1. **Snippets with a language crashed (500).** MongoDB treats any field named `language` as the text-search language. Fixed with `language_override` on the text index (renamed to `note_text_v2`). This also affected the earlier Phase 2 build running against your Atlas DB.
2. **The PDF library required Node ≥ 20.16** (you run 20.10), so the API would crash on start. Replaced with `pdfjs-dist@4.8.69`, which supports Node 18+ and includes the CVE-2024-4367 fix (`isEvalSupported: false` is also set).
3. **Editing an uploaded document would have erased its file details.** Metadata now merges field by field.
4. **Empty `metadata` disappeared from responses.** The schema now uses `minimize: false`.

## 5. Browser UI tests: 23 scenarios, all passing
Run in Chrome against the local test stack (section 6): Firebase Auth emulator, in-memory MongoDB, API on :4100, web on :3100. Two throwaway emulator accounts were used; no real Firebase or Atlas data was touched.

| ID | Steps | Expected | Result |
|---|---|---|---|
| UI-01 | Look at the left sidebar | Sections separated by horizontal lines: buttons / Views / Type / Folders / Tags / Sign out | ✅ Pass |
| UI-02 | Press `N` (or click **New item**) | Popup opens with Write / Upload file tabs; Title is focused | ✅ Pass (after fix #5) |
| UI-03 | Type title, content, tags → `Ctrl+Enter` | Dialog closes, "Item created" toast, tags lowercased | ✅ Pass |
| UI-04 | Click **Edit** on an item, change it, save | Pre-filled "Edit note" dialog; "Changes saved" | ✅ Pass |
| UI-05 | Edit, change text, press `Esc` several times, answer Cancel | Dialog stays open with the edit; answering OK discards and closes | ✅ Pass (after fix #6) |
| UI-06 | Change Type to Snippet, language "ts", save | Language field appears; monospace content; card shows "SNIPPET ts" | ✅ Pass |
| UI-07 | Sidebar **Upload file** → drop a PDF, pick folder + tags → Upload | Document card with file name, size, page count, folder and tags | ✅ Pass |
| UI-08 | New item → Upload file tab → drop a `.docx` | Word text extracted; file name with spaces kept | ✅ Pass |
| UI-09 | Drop a `.png`, an 11 MB file, and a text file named `.pdf` | "Unsupported file type…", "File is too large (max 10 MB)", "The file's contents don't match its extension" | ✅ Pass |
| UI-10 | **Edit** an uploaded PDF, add a line, save | "From file …" info shown; file details still on the card after saving | ✅ Pass |
| UI-11 | **+ New folder** → name → Enter (twice) | Folders appear alphabetically with count 0 | ✅ Pass |
| UI-12 | Pencil icon next to a folder → rename → Enter | Name updates, list re-sorts, "Renamed to …" toast | ✅ Pass |
| UI-13 | Rename / create with an existing name (any case) | Error shown under the input; clicking away cancels | ✅ Pass (after fix #8) |
| UI-14 | Move an item into a folder, then delete that folder | Confirmation; folder gone; item now under Unfiled | ✅ Pass |
| UI-15 | Paste `example.com` → Save link | Link item "Example Domain" | ✅ Pass |
| UI-16 | Search "retr", then "revenue", then nonsense | Partial match on "Retry helper"; PDF text found; empty-state message | ✅ Pass |
| UI-17 | Click type, folder, tag and Unfiled filters | List narrows; heading changes | ✅ Pass |
| UI-18 | Delete an item → **Undo** | Item comes back | ✅ Pass |
| UI-19 | Trash → Restore / Delete forever / Empty trash | Each works, with confirmations | ✅ Pass (after fix #9) |
| UI-20 | Press `/` | Search box focused | ✅ Pass |
| UI-21 | Pin and archive / unarchive | Pinned item first with gold border; archived moves to Archived view | ✅ Pass |
| UI-22 | Phone width (375 px) | No sideways scrolling; popup fits the screen | ✅ Pass |
| UI-23 | Sign out, create a second account | New account sees no items, folders or tags from the first | ✅ Pass |

No JavaScript errors in the browser console and no server errors in the API log during the run.

### Bugs the browser tests found and fixed
5. **The popup focused the × button instead of the Title field.** `showModal()` overrides React's `autoFocus`, so focus is now set after the dialog opens.
6. **Pressing Esc twice could make the editor invisible but still "open"**, so `N` stopped working until a reload. Chrome lets a page block a dialog's close only once per interaction. Esc is now handled on keydown, and the dialog reopens itself if the browser ever closes it.
7. **Folder edit/delete icons were tiny and faint** (emoji rendering depends on the OS font). Replaced with SVG icons.
8. **Folder errors (e.g. duplicate name) were invisible.** The page banner was cleared by the next list refresh. Errors now show directly under the folder input.
9. **Race condition: a view could show the wrong items.** Deleting an item and quickly switching to Trash showed active items under the Trash heading, because a slow response for the old view arrived last. Now only the newest request may update the list, and actions refresh with the current filters.

Also polished: "10.0 MB" now reads "10 MB", and the "partial-word matches" label is hidden when nothing matched.

Known limitation (planned for Phase 7 polish): on phones the full sidebar sits above the list; a collapsible menu would be nicer.

## 6. Local test stack (no real Firebase / Atlas)
For browser testing without touching real data:
1. In-memory DB: `npx tsx apps/api/scripts/memory-mongo.ts` (port 27999)
2. Firebase Auth emulator: `firebase emulators:start --only auth --project demo-mindmesh` (port 9099, configured in `firebase.json`). On Node 20, install `firebase-tools@13.29.1` with an npm override `"universal-analytics": "0.5.3"`; newer releases and plain `npx` pull in packages that need Node 22.
3. API: run `npm run dev -w apps/api` with `PORT=4100`, `MONGODB_URI=mongodb://127.0.0.1:27999/mindmesh_local_test`, `FIREBASE_PROJECT_ID=demo-mindmesh`, `FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`, `CLIENT_ORIGIN=http://localhost:3100`.
4. Web: run `npx next dev -p 3100` in `apps/web` with `NEXT_DIST_DIR=.next-e2e`, `NEXT_PUBLIC_API_URL=http://localhost:4100`, `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID=demo-mindmesh`, `NEXT_PUBLIC_FIREBASE_API_KEY=demo-key`.

Emulator mode is refused when `NODE_ENV=production`.

## 7. Not in Phase 2 (by design)
- Storing original files (would need a private storage bucket and its security design; planned for Phase 3)
- Scanned / image-only PDFs (needs OCR)
- Old `.doc`, `.pptx`, `.xlsx` formats
