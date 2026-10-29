# Deploying MindMesh for free

MindMesh runs entirely on free plans with no credit card:

| Part | Where | Free plan |
|---|---|---|
| Web app (static files) | **Firebase Hosting** | Spark: 10 GB storage, 360 MB/day transfer |
| API + background worker | **Render** web service | 512 MB RAM; sleeps after 15 idle minutes, wakes in ~30–60 s |
| Database | **MongoDB Atlas** M0 | 512 MB storage, Vector Search included |
| Sign-in | **Firebase Authentication** | Email/password and Google |
| Search and answers | Local embedding model + smart quotes | No API key, no cost |

```
browser ──► Firebase Hosting (static web app)
   │
   ├─► Firebase Auth (sign-in, ID tokens)
   │
   └─► Render: MindMesh API ──► MongoDB Atlas (notes, chunks, vectors, job queue)
             └─ worker loop (same process): extract → chunk → embed (local model) → store
```

It takes about 30 minutes the first time. Steps marked **you** need your accounts. Nothing here costs money.

## 0. Before you start
- The code is on GitHub (Render deploys from it). This repository: `nidhiprajapati4/MindMesh`.
- Node 20 and npm installed locally.
- A Firebase project with Authentication enabled (Email/Password, and Google if you want it). This repository uses `mindmesh-267a3` (`.firebaserc`); change it for your own project.
- A MongoDB Atlas cluster (M0 is fine) and its connection string.

## 1. MongoDB Atlas (you)
1. **Database Access:** create a database user with a long random password (Atlas can generate one). Role: *Read and write to any database*.
2. **Network Access:** add `0.0.0.0/0` (allow from anywhere). Render's free plan has no fixed outgoing IP, so this is required; the strong password is what protects the database.
3. **Connect → Drivers:** copy the connection string and put the password in it. Add a database name before the `?`, e.g. `…mongodb.net/mindmesh?retryWrites=true&w=majority`.

The API creates its indexes and the Vector Search indexes itself on first start (they become usable a minute or two later; until then search falls back to in-memory ranking).

## 2. Firebase service account (you)
Firebase console → ⚙ Project settings → **Service accounts** → **Generate new private key**. A JSON file downloads. You need two values from it: `client_email` and `private_key`. Keep the file private and never commit it.

## 3. Render: the API (you)
1. Sign up at [render.com](https://render.com) with GitHub (free, no card).
2. **New → Blueprint** → choose the MindMesh repository. Render reads [`render.yaml`](../render.yaml) and proposes the `mindmesh-api` service on the free plan.
   - The blueprint uses the `singapore` region. Change `region` in `render.yaml` first if your Atlas cluster is elsewhere (`oregon`, `ohio`, `virginia`, `frankfurt`).
3. Fill in the values it asks for:

| Key | Value |
|---|---|
| `MONGODB_URI` | the Atlas connection string from step 1 |
| `FIREBASE_PROJECT_ID` | your project id, e.g. `mindmesh-267a3` |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from step 2 |
| `FIREBASE_PRIVATE_KEY` | `private_key` from step 2 (with or without its quotes; `\n`s or real line breaks both work) |
| `CLIENT_ORIGIN` | `https://<project-id>.web.app,https://<project-id>.firebaseapp.com` |

4. **Apply.** The first build takes about 3 minutes. It installs dependencies and downloads the 23 MB embedding model. The API runs from its TypeScript source through `tsx`, because the free build machine is too small for the TypeScript compiler.
   - Render applies `render.yaml` when the service is **created**. If you change its commands later, also update **Settings → Build Command / Start Command**; Render didn't sync them for us.
   - Instead of a blueprint you can create a plain **New → Web Service** with the same settings: Build Command `unset NODE_OPTIONS && npm ci --include=dev && npm run prefetch-model -w apps/api`, Start Command `node --max-old-space-size=320 --import tsx apps/api/src/index.ts`, Health Check Path `/ready`, Instance type **Free**, and the environment variables listed in `render.yaml`.
5. If the log says `MongooseServerSelectionError … IP that isn't whitelisted`, Atlas Network Access doesn't yet list `0.0.0.0/0` as **Active** (step 1). The Atlas **Connect** dialog only adds *your* IP.
6. When it shows **Live**, open `https://<service>.onrender.com/ready`. Expect `{"ok":true,"db":"up","worker":"running",…}`. Copy the service URL: the web app needs it.

## 4. Firebase Hosting: the web app (you run the commands)
1. `apps/web/.env` (see [`apps/web/.env.example`](../apps/web/.env.example)) holds your Firebase web settings. Put the deployed API's address in **`apps/web/.env.production`**, which only production builds read, so `npm run dev:web` keeps using your local API:
   ```
   NEXT_PUBLIC_API_URL=https://<service>.onrender.com
   ```
   These values end up in the public site; that is normal for Firebase web settings. Don't put secrets here.
2. Stop `npm run dev:web` if it is running (the build uses the same `.next` folder), then build the static site into `apps/web/out`:
   ```bash
   npm run build:web
   ```
3. Sign in to Firebase and deploy. The Firebase CLI version is pinned so the steps stay the same (older 13.x versions now crash when downloaded fresh):
   ```bash
   npx -y firebase-tools@15.33.0 login
   ```
   ```bash
   npx -y firebase-tools@15.33.0 deploy --only hosting
   ```
   It prints the address: `https://<project-id>.web.app`.
4. Firebase console → **Authentication → Settings → Authorized domains**: make sure `<project-id>.web.app` and `<project-id>.firebaseapp.com` are listed (Firebase usually adds them; Google sign-in fails without them).

## 5. Check it works
On `https://<project-id>.web.app`:
1. Sign up with email and password (and Google, if enabled).
2. Write a note, save a link, upload a small PDF. Cards show "Processing…", then not.
3. Search by meaning, ask a question (smart quotes, with citations).
4. Write a near-copy of a note: the duplicate warning appears. Open the graph.
5. On a phone: the ☰ Menu drawer works.
6. In the browser's developer tools, API responses carry an `X-Request-Id` header.

Optionally fill a demo account (run locally with the production `MONGODB_URI` in `apps/api/.env`):
```bash
npm run demo:seed -w apps/api -- --email you@example.com
```

## 6. Automatic deploys (you, once)
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) deploys both parts **only when a pull request is merged into `main`**: it runs the tests on the merge commit, then deploys the API to Render and waits until `/ready` reports that commit, then builds and deploys the web app to Firebase Hosting. A direct push to `main`, or a PR closed without merging, deploys nothing. The API goes first, so the new web app never talks to an older API.

One-time setup:
1. **Render deploy hook.** Render → your service → **Settings → Deploy Hook**: copy the URL. GitHub → repository → **Settings → Secrets and variables → Actions → New repository secret**: name `RENDER_DEPLOY_HOOK_URL`. Then in Render **Settings → Build & Deploy → Auto-Deploy**: set **No**, so only the pipeline deploys (`render.yaml` says the same for new blueprints).
2. **Firebase deploy key.** Firebase console → ⚙ Project settings → Service accounts → Generate new private key (a *new* key; keep the one from step 2 for Render). In Google Cloud console → IAM, give that service account the **Firebase Hosting Admin** role. Save the whole JSON file's contents as the repository secret `FIREBASE_SERVICE_ACCOUNT`, then delete the file.
3. **Firebase web settings.** Under the same *Actions* page → **Variables** tab, add `NEXT_PUBLIC_FIREBASE_API_KEY`, `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`, `NEXT_PUBLIC_FIREBASE_PROJECT_ID` and `NEXT_PUBLIC_FIREBASE_APP_ID` (the same public values as in `apps/web/.env`). The API address comes from `apps/web/.env.production`.
4. *(Optional)* **Settings → Environments → production-api / production-web**: add yourself as a required reviewer for a manual approval before each deploy.
5. *(Recommended)* **Settings → Branches → Add rule** for `main`: require a pull request and the **check** status before merging, so only tested code can reach the pipeline.

A failed deploy shows red in the **Actions** tab; nothing later runs. If only the web step fails, re-run that job. Because Render's free plan has no zero-downtime swap, the API can be unreachable for a few seconds when it switches over.

## Updating
- **Normal way:** open a pull request, let CI pass, merge it. The Deploy workflow does the rest (about 6–10 minutes, mostly Render's build).
- **By hand** (if the pipeline is unavailable): Render → **Manual Deploy**, and `npm run deploy:web` for the web app.

Keeping it running, logs, error codes and key rotation: [operations.md](operations.md).

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Render build fails at `npm ci` | Node version: the blueprint sets `NODE_VERSION=20` |
| Render build: `tsc` "heap out of memory" / "Aborted (core dumped)", exit 134 | The free build machine can't fit the TypeScript compiler. The blueprint doesn't compile on Render: check Settings → Build Command and Start Command match `render.yaml` (they run the source through `tsx`), and delete any `NODE_OPTIONS` variable in Environment |
| `/ready` says `"db":"down"` | `MONGODB_URI` wrong, or Atlas Network Access doesn't allow `0.0.0.0/0` |
| API exits at start with "FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are required" | A service-account value is missing in Render → Environment |
| Sign-in works but every request says "Your session has expired" | `FIREBASE_PROJECT_ID` doesn't match the web app's project |
| Browser console: "blocked by CORS policy" | `CLIENT_ORIGIN` doesn't list the exact web address (no trailing slash) |
| Google sign-in popup closes with an error | The domain isn't in Authentication → Authorized domains |
| First request after a while takes up to a minute | Normal on the free plan: the API was asleep |
| Notes stay "Processing…" | The API was asleep; they continue when it wakes. `/ready` should show `"worker":"running"` |
| `npm run build:web` fails with `EPERM … .next\trace` | `npm run dev:web` is still running and holds the `.next` folder: stop it first |
| Deploy workflow: "RENDER_DEPLOY_HOOK_URL secret is missing" / "FIREBASE_SERVICE_ACCOUNT secret is missing" | Step 6 isn't finished; add the secret in GitHub → Settings → Secrets and variables → Actions |
| Deploy workflow waits, then "did not go live" | The Render build failed (see its Events/Logs), or the service still has Auto-Deploy on and is building another commit |
| Deploy workflow: Firebase "403" / "permission" error | The deploy service account lacks the Firebase Hosting Admin role |
| `npx firebase-tools@13.x` fails with `ERR_REQUIRE_ESM` (uuid) | Old 13.x versions pick up a broken `universal-analytics` release when downloaded fresh; use `firebase-tools@15.33.0` as above |
