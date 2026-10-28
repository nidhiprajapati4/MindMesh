# MindMesh AI — Phase 7 (final): Launch

Status: **Complete, and live at https://mindmesh-267a3.web.app** (API: https://mindmesh-api-5msj.onrender.com). Everything runs on free plans with no card: Firebase Hosting (Spark) for the web app, Render (free) for the API and its worker, MongoDB Atlas M0, Firebase Auth, and the local embedding model.

181 automated API tests pass (172 from Phases 1–6, 9 new), CI runs on every push, and the browser and live checks are listed in [phase7_Test_Scenarios.md](phase7_Test_Scenarios.md). Deploying for real exposed seven problems that local testing couldn't; all are fixed and written into the guides (section 5). The final review found one more: a database failure during sign-in was reported as "session expired" (fixed, test OPS-08).

## 1. What Phase 7 adds
| Area | Details |
|---|---|
| **One error format** | Every error is `{ error: { code, message, requestId, details? } }` with stable codes (`VALIDATION_FAILED`, `NOT_FOUND`, `RATE_LIMITED`, `QUOTA_EXCEEDED`, `INTERNAL`…). Unknown routes too |
| **Request ids** | Every response has `X-Request-Id` (a valid incoming id is kept); errors include it, and server errors in the app show "(Reference: 6d330520)" to find the request in the logs |
| **Structured logs** | One JSON line per request (route pattern, status, time, request and user id) and per background job; readable "pretty" lines locally. Never note text, questions, search terms or keys |
| **Rate limits** | Per user (300/min), per IP before sign-in (600/min), uploads and saved links (20/min), suggestions (60/min), questions (10/min). `429 RATE_LIMITED` with `Retry-After` |
| **Health** | `/health` (alive) and `/ready` (database up, worker state, embedding model state); clean shutdown on SIGTERM |
| **Worker inside the API** | `RUN_WORKER=inline`, for hosts without background workers |
| **Free deployment** | `render.yaml` blueprint, model downloaded at build, static export for Firebase Hosting with security headers and a Content Security Policy, `.env.example` files |
| **Web polish** | "The server may be waking up…" notice for slow requests, a slide-out menu on phones (the Phase 2 limitation), 404 and error pages |
| **CI and upkeep** | GitHub Actions (typecheck, tests, both builds), Dependabot, `npm run check` |
| **Demo data** | `npm run demo:seed -w apps/api -- --email you@example.com` adds about 65 notes in 7 folders, with links, a long document, near-copies and a saved link |
| **Docs** | New README, [docs/deploy.md](docs/deploy.md), [docs/operations.md](docs/operations.md) |
| **Better topics** | Two existing topics now merge only through a strong connection (≥ 0.5), so one borderline note can't glue them together |

## 2. Where it runs
```
browser ──► Firebase Hosting: static web app (CSP, HSTS, no framing)
   ├─► Firebase Auth: sign-in, ID tokens
   └─► Render (free): MindMesh API + worker loop ──► MongoDB Atlas M0
         runs the TypeScript source via tsx, 320 MB heap cap, model cached at build
```
- **Cold starts:** Render's free plan sleeps after 15 idle minutes; the next request waits 30–60 s. The web app shows a notice after 4 s, and notes saved meanwhile are processed when it wakes (the queue is in MongoDB).
- **Memory:** with the model loaded and 40 notes processed, the API peaked at 237 MB of the plan's 512 MB.
- **No compile on Render:** the TypeScript compiler needs ~430 MB, more than the free build machine gives it, so Render runs the source through `tsx`; types are checked in CI.

## 3. Settings added
| Variable | Default | Meaning |
|---|---|---|
| `RUN_WORKER` | `separate` | `inline` runs the worker inside the API |
| `RATE_LIMIT_PER_MINUTE` | 300 | Per-user limit; the other limits derive from it |
| `TRUST_PROXY` | 0 | Proxies in front of the API (1 on Render), for client IPs |
| `LOG_FORMAT` | `pretty` (`json` in production) | Log line format |
| `LOG_LEVEL` | `info` (silent in tests) | `debug` also logs every embedding call |
| `NEXT_PUBLIC_API_URL` in `apps/web/.env.production` | — | The deployed API, used by production builds only |

## 4. Scripts
| Command | What it does |
|---|---|
| `npm run check` | Typecheck, API tests, API build, web static export |
| `npm run build:web` | Static site into `apps/web/out` (stop `npm run dev:web` first: both use `.next`) |
| `npm run deploy:web` | Build, then deploy to Firebase Hosting (`firebase-tools@15.33.0`) |
| `npm run demo:seed -w apps/api -- --email …` | Fill an account with demo notes (refuses a non-empty account without `--force`) |
| `npm run prefetch-model -w apps/api` | Download and check the embedding model (used by the Render build) |

## 5. Problems found by deploying, and fixes
1. **Next.js static export ignored the custom build folder** and always built in `.next`, colliding with a running dev server (`EPERM … .next\trace`). The export now always uses `.next` → `out/`, and the guide says to stop `npm run dev:web` first.
2. **`npx firebase-tools@13.29.1` crashed** (`ERR_REQUIRE_ESM`): a May 2026 release of its dependency `universal-analytics` needs an ES-module-only `uuid`. Pinning the CLI inside the project broke `npm ci` on Linux instead (fix 3), so deploys use `npx firebase-tools@15.33.0`, which works.
3. **`npm ci` failed on Render and CI** ("lock file's picomatch@2.3.2 does not satisfy picomatch@4.0.7") after that pin; Windows' npm accepted the same lockfile. The CLI was removed from the project and the lockfile restored; CI now guards it.
4. **Memory cap applied to the build:** `NODE_OPTIONS=--max-old-space-size=320` also limited `tsc`, which aborted. The cap moved to the start command.
5. **The free build machine can't run `tsc` at all** (heap out of memory). Render now runs the source through `tsx` (no compile step); it also used less memory at runtime.
6. **Firebase key not readable** ("Failed to parse private key"): dashboards keep the JSON quotes or double the `\n`s. The key is now normalised from any common pasted form, with a clear error otherwise (test OPS-07).
7. **Atlas refused Render** (`MongooseServerSelectionError … not whitelisted`): Atlas's Connect dialog only allows your own IP; Network Access needs `0.0.0.0/0` for Render's changing addresses. Also: Render didn't apply changed commands from `render.yaml` to an existing service. Both are in the deploy guide.

Found while preparing the demo: in a richer library, *Load testing with k6* (0.40 similar to both) merged the running and Kubernetes topics into one. Topics that already exist now merge only through a connection of at least 0.5 (test TOPIC-05); the Phase 6 evaluation scores are unchanged.

## 6. Limits
- **Free-plan cold starts** of 30–60 s after 15 idle minutes, and Render's 750 free hours a month (one always-on service fits).
- **One API instance:** rate limits are kept in memory, which is right for one instance; several would need a shared store.
- **Atlas M0** has no automatic backups (see [docs/operations.md](docs/operations.md) for `mongodump`), 512 MB of storage, and allows connections from any address, so the database password must stay strong.
- **The Content Security Policy** allows inline scripts, which Next.js's static pages need; it still limits where the page can connect and load from.
- **Screenshots** in the README come from a local copy with demo data, not from a real user's account.
