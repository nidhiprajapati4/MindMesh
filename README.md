# MindMesh AI — Phase 2: Organize, search & capture (no AI)

Phase 1: auth (Firebase) + notes CRUD, tags, pin/archive, MongoDB text search.
Phase 2 adds item types, folders, richer metadata, URL capture, keyword search with filters and sorting,
and a recoverable trash.
Still no OpenAI, embeddings, RAG or agents (those start in Phase 3).

## What's in Phase 2
| Requirement | Implemented |
|---|---|
| FR-05 item `type` | `note`, `snippet`, `url`, `idea`, `document` (existing notes are backfilled to `note` on startup) |
| FR-07 folders & metadata | Per-user folders (unique names, rename, delete → items become unfiled); `metadata` = `language`, `siteName`, `description`, `author`; `sourceUrl` |
| FR-08 keyword search & filters | Full-text search ranked by relevance, with partial-word fallback; filter by type, folder, tag, pinned, date range; sort by updated / created / title / relevance; "Load more" pagination |
| FR-09 URL capture | `POST /api/notes/capture-url` fetches title/description/site name server-side with SSRF protection (private/loopback/metadata IPs blocked at connect time, redirects re-checked, 5 s timeout, 512 KB cap, ports 80/443 only). File upload is **not** included yet; it waits for the storage security design. |
| Soft delete | Delete → Trash (undo toast); restore; delete forever; empty trash. A TTL index purges trashed items after 30 days. |
| H1 fast capture | `N` new item, `/` search, `Ctrl/⌘+Enter` save, `Esc` cancel, paste-a-link capture bar |

Not done yet (Phase 1 NFRs still open): `{ error: { code, message, requestId } }` error shape, request-ID logging, rate limiting, CI.

## Setup
1. Firebase console: create a project, enable Authentication (Email/Password + Google), register a Web app.
2. Project settings > Service accounts > generate a private key (for the API).
3. MongoDB Atlas: create a cluster and copy the connection string.
4. Fill in `apps/api/.env` and `apps/web/.env` (see `apps/api/src/config/env.ts` for the API keys).
5. `npm install` at the repo root.
6. `npm run dev:api` (port 4000) and `npm run dev:web` (port 3000).
7. `npm test -w apps/api` runs the unit tests (schemas, SSRF guard, HTML metadata parsing).

On startup the API backfills Phase 1 notes and runs `syncIndexes()`, which replaces the Phase 1 text index with the Phase 2 one.

## API (all `/api/*` routes need `Authorization: Bearer <Firebase ID token>`)
- `GET /health`
- `GET /api/me`

Notes
- `GET /api/notes?q=&type=&folder=<id|none>&tag=&pinned=&view=active|archived|trash&from=&to=&sort=updated|created|title|relevance&page=1&limit=20`
  → `{ items, total, page, limit, matchMode: 'all'|'text'|'partial' }`
- `GET /api/notes/tags`
- `POST /api/notes` · `GET|PATCH /api/notes/:id`
- `POST /api/notes/capture-url` `{ url, folderId?, tags? }`
- `DELETE /api/notes/:id` (move to trash) · `POST /api/notes/:id/restore`
- `DELETE /api/notes/:id/permanent` (trashed items only) · `DELETE /api/notes/trash` (empty trash)

Folders
- `GET /api/folders` → `{ folders: [{ _id, name, color, noteCount }], unfiledCount }`
- `POST /api/folders` `{ name, color? }` · `PATCH|DELETE /api/folders/:id`
