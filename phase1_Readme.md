# MindMesh AI — Phase 1: Core notes

Status: **Implemented.** Some Phase 1 non-functional items from the architecture doc are still open (see the end of this file).

## What Phase 1 delivers
| ID | Requirement | How it's done |
|---|---|---|
| FR-01 | Sign in / out | Firebase Authentication (email + password, Google) in `apps/web/src/lib/auth-context.tsx` |
| FR-02 | Verify the ID token on every protected request | `apps/api/src/middleware/auth.ts` (Firebase Admin `verifyIdToken`) |
| FR-03 | Create, read, list, update, delete items | `apps/api/src/modules/notes/` |
| FR-04 | Users only see their own items | Every query filters by `userId` taken from the verified token; another user's item returns 404 |
| FR-05 | Title, content, tags | `apps/api/src/models/Note.ts` (item `type` was added in Phase 2) |
| FR-06 | Pagination | `page` / `limit` (default 20, max 100) |
| — | Pin / archive, keyword search | `pinned`, `archived`, MongoDB text index |
| NFR-02 | Input validated with Zod | `*.schema.ts` files |
| NFR-03 | Secrets in env vars | `apps/api/.env`, `apps/web/.env` (not committed) |

## Stack
- `apps/web`: Next.js 15, React 19, Tailwind
- `apps/api`: Express 5, TypeScript, Zod, Mongoose
- Firebase Auth; MongoDB Atlas

## Run it
1. `npm install` at the repo root.
2. Fill in `apps/api/.env` (`MONGODB_URI`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `CLIENT_ORIGIN`) and `apps/web/.env` (`NEXT_PUBLIC_FIREBASE_*`, `NEXT_PUBLIC_API_URL`).
3. `npm run dev:api` (port 4000) and `npm run dev:web` (port 3000).

## Phase 1 API
- `GET /health`, `GET /api/me`
- `GET /api/notes?q=&tag=&archived=&page=&limit=`, `GET /api/notes/tags`
- `POST /api/notes`, `GET|PATCH|DELETE /api/notes/:id`

(Phase 2 extends these; see `phase2_Readme.md`.)

## Test scenarios covered
Phase 1 behaviour is covered by the automated suite (`npm test -w apps/api`). Results are listed in `phase2_Readme.md`:
- Auth: AUTH-01 to AUTH-03
- CRUD and validation: NOTE-01 to NOTE-08
- Ownership isolation: ISO-01 to ISO-03
- Search and pagination: SRCH-01 to SRCH-06

## Still open from the Phase 1 spec (planned)
- Error format `{ error: { code, message, requestId } }` (NFR-02 conventions)
- Request IDs and structured logs (NFR-06)
- Basic rate limiting (NFR-04)
- CI pipeline running the tests (NFR-08)
