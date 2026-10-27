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
| `FIREBASE_PRIVATE_KEY` | `private_key` from step 2, pasted exactly as in the JSON (with its `\n`s) |
| `CLIENT_ORIGIN` | `https://<project-id>.web.app,https://<project-id>.firebaseapp.com` |

4. **Apply.** The first build takes about 5 minutes (it installs dependencies, compiles the API and downloads the 23 MB embedding model).
5. When it shows **Live**, open `https://<service>.onrender.com/ready`. Expect `{"ok":true,"db":"up","worker":"running",…}`. Copy the service URL: the web app needs it.

## 4. Firebase Hosting: the web app (you run the commands)
1. Create `apps/web/.env` (see [`apps/web/.env.example`](../apps/web/.env.example)) with your Firebase web settings and the API address:
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

## Updating
- **API:** push to `main`; Render redeploys automatically (CI runs the tests on GitHub too).
- **Web app:** `npm run deploy:web` (builds, then deploys to Firebase Hosting).

Keeping it running, logs, error codes and key rotation: [operations.md](operations.md).

## Troubleshooting
| Symptom | Likely cause |
|---|---|
| Render build fails at `npm ci` | Node version: the blueprint sets `NODE_VERSION=20` |
| Render build: `tsc` "Aborted (core dumped)", exit 134 | Out of memory: a `NODE_OPTIONS=--max-old-space-size=…` environment variable also caps the build. Delete it in Render → Environment; the start command sets the server's cap itself |
| `/ready` says `"db":"down"` | `MONGODB_URI` wrong, or Atlas Network Access doesn't allow `0.0.0.0/0` |
| API exits at start with "FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are required" | A service-account value is missing in Render → Environment |
| Sign-in works but every request says "Your session has expired" | `FIREBASE_PROJECT_ID` doesn't match the web app's project |
| Browser console: "blocked by CORS policy" | `CLIENT_ORIGIN` doesn't list the exact web address (no trailing slash) |
| Google sign-in popup closes with an error | The domain isn't in Authentication → Authorized domains |
| First request after a while takes up to a minute | Normal on the free plan: the API was asleep |
| Notes stay "Processing…" | The API was asleep; they continue when it wakes. `/ready` should show `"worker":"running"` |
| `npm run build:web` fails with `EPERM … .next\trace` | `npm run dev:web` is still running and holds the `.next` folder: stop it first |
| `npx firebase-tools@13.x` fails with `ERR_REQUIRE_ESM` (uuid) | Old 13.x versions pick up a broken `universal-analytics` release when downloaded fresh; use `firebase-tools@15.33.0` as above |
