# Phase 7 test scenarios: Launch

Every Phase 7 test scenario: what it checks, how it was run, and its latest result. Feature details are in [phase7_Readme.md](phase7_Readme.md).

| Kind | Scenarios | Latest result |
|---|---|---|
| Automated API tests (Phase 7) | 9 | ✅ 9 / 9 pass (whole suite: 181 / 181) |
| CI on GitHub Actions | every push | ✅ typecheck, tests, API build, web static export |
| Deployment checks (local) | 4 | ✅ 4 / 4 pass |
| Browser checks on the production build (local) | 8 | ✅ 8 / 8 pass |
| Live checks on the deployed site | 9 | ✅ 9 / 9 pass |

## How to run
```bash
npm run check
```
Runs the typecheck, the API tests (in-memory database, fake models, no accounts), and both production builds. The same steps run in CI on every push.

---

## 1. Automated (`apps/api/src/test/phase7.test.ts`, and TOPIC-05 in `phase6.test.ts`)
| ID | Scenario | Expected | Result |
|---|---|---|---|
| OPS-01 | Invalid body, malformed JSON, no token, bad token, missing note, unknown route | `400 VALIDATION_FAILED` (with field details), `400 MALFORMED_JSON`, `401 UNAUTHORIZED` ×2, `404 NOT_FOUND` ×2; every body has a message and the same request id as the `X-Request-Id` header | ✅ |
| OPS-08 | The account lookup fails during sign-in (database unreachable) | `500 INTERNAL` with a request id and no internal details, not "session expired"; works again afterwards | ✅ |
| OPS-02 | Request ids | A UUID on every response; a valid incoming id is kept; an id containing markup is replaced; browsers may read the header (CORS) | ✅ |
| OPS-03 | A user exceeds the per-user limit (lowered to 3 for the test) | 4th request `429 RATE_LIMITED` with `Retry-After`; another user is unaffected | ✅ |
| OPS-04 | Saved links over their stricter limit; requests before sign-in over the IP limit | `429` for the saved link while ordinary requests work; `429` for token checks; `/health` never limited | ✅ |
| OPS-05 | `/ready`, then during shutdown | `200 { ok, db: up, worker, embeddingModel }`; `503` with `shuttingDown` | ✅ |
| OPS-06 | The worker loop inside the process | Processes a queued note to `ready`; stops promptly when idle | ✅ |
| OPS-07 | Firebase private key pasted six ways (real line breaks, `\n` escapes, with quotes, doubled escapes, Windows line endings, stray spaces); three wrong values | All six produce a usable key; wrong values get a message naming the expected format, without echoing the value | ✅ |
| TOPIC-05 | Two tight groups and one note 0.42 similar to both | Two topics, not one (without the merge bar all 7 notes became one topic) | ✅ |

Changed tests: ASK-12 now also checks the stream's error event carries a request id; four earlier tests read the new error shape.

## 2. Deployment checks (local)
| ID | Check | Result |
|---|---|---|
| DEP-01 | The API with the inline worker under a 320 MB heap cap, real model, 40 notes | ✅ processed in 6 s; meaning search works; peak memory 237 MB (via `tsx`) / 261 MB (compiled) of Render's 512 MB |
| DEP-02 | `tsc` memory | Aborts at 320 MB, passes at 400 MB (uses ~430 MB), hence no compile on Render |
| DEP-03 | Static export | `out/` has every page and `404.html`; the CSP names exactly the configured API and Firebase sign-in domains |
| DEP-04 | `demo:seed` | Unknown email refused; 64 notes in 7 folders added; links resolved, "Picnic menu" left waiting as intended; second run refused without `--force`; all 64 processed by the worker |

## 3. Browser checks on the production build (local test stack)
The static export served like Firebase Hosting, with the API behind a proxy that could delay requests; Firebase Auth emulator; in-memory MongoDB.

| ID | Steps | Expected | Result |
|---|---|---|---|
| UI-01 | Sign in on the exported site | Works under the Content Security Policy; no policy errors in the console | ✅ |
| UI-02 | Make the API answer after 8 s, then search | "Still working… The server may be waking up…" appears after 4 s and clears when results arrive | ✅ |
| UI-03 | Use up the user's request limit, then search | "Too many requests. Wait a minute and try again." | ✅ |
| UI-04 | Open `/no-such-page` | "Page not found" with a link to your notes | ✅ |
| UI-05 | Phone width (375 px): notes page | Sidebar hidden and not focusable; ☰ Menu bar shown; no sideways scroll | ✅ |
| UI-06 | Open the menu | Drawer slides in over a backdrop; focus moves to its close button | ✅ |
| UI-07 | Choose the Kitchen folder in the drawer | Drawer closes, list shows Kitchen's notes, heading "Kitchen" | ✅ |
| UI-08 | Open the menu, press Esc | Drawer closes; focus back on the Menu button | ✅ |

## 4. Live checks (https://mindmesh-267a3.web.app with https://mindmesh-api-5msj.onrender.com)
| ID | Check | Result |
|---|---|---|
| LIVE-01 | Site headers | ✅ HSTS, `nosniff`, `X-Frame-Options: DENY`, referrer and permissions policies |
| LIVE-02 | Site's CSP | ✅ allows exactly the Render API and Firebase sign-in |
| LIVE-03 | Unknown page | ✅ `404` with the custom page |
| LIVE-04 | API `/ready` | ✅ `db: up`, `worker: running`, `embeddingModel: loaded`, in under a second when awake |
| LIVE-05 | CORS preflight from the site | ✅ `204`, allowed origin is the site |
| LIVE-06 | API without sign-in | ✅ `401 UNAUTHORIZED` with a request id |
| LIVE-07 | The live sign-in page | ✅ loads, reaches the API, no console errors |
| LIVE-08 | Sign up, write a note, save a link, search by meaning, Ask (done by the owner) | ✅ all work |
| LIVE-09 | Phone (done by the owner) | ✅ |
