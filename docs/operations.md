# Running MindMesh: operations guide

How to keep an eye on a deployed MindMesh (Firebase Hosting + Render + MongoDB Atlas) and what to do when something goes wrong. Setting it up is in [deploy.md](deploy.md).

## Is it up?
| Check | Where | Healthy |
|---|---|---|
| Web app | `https://<project>.web.app` | The sign-in page loads |
| API alive | `https://<api>.onrender.com/health` | `{"ok":true}` |
| API ready | `https://<api>.onrender.com/ready` | `200` with `"db":"up"`, `"worker":"running"` |
| Embedding model | same `/ready` | `"embeddingModel":"loaded"` after the first note or search (it loads on first use) |

Render calls `/ready` itself and restarts the service if it keeps failing.

**Free plan behaviour:** the API sleeps after 15 minutes without requests. The next request wakes it, which takes about 30–60 s; the web app shows "The server may be waking up…" meanwhile. Notes saved just before it slept are prepared for search when it wakes (the job queue is in MongoDB, so nothing is lost).

**Optional uptime alerts (free):** an [UptimeRobot](https://uptimerobot.com) HTTP monitor on `/health` every 5 minutes emails you when the API is down. Note that pinging it also keeps it awake, which uses more of Render's free monthly hours (750 per month; one always-on service fits).

## Logs
Render dashboard → the `mindmesh-api` service → **Logs**. Each line is one JSON object:
```json
{"t":"2026-10-27T11:19:04.228Z","level":"info","evt":"http","method":"POST","route":"/api/notes/","status":201,"ms":42,"requestId":"6d330520-…","userId":"6ae0…"}
```
| `evt` | Meaning |
|---|---|
| `http` | One per request: route pattern (never the URL, so search text isn't logged), status, duration, request id, user id |
| `job` | The worker handled a note (`outcome`: `ready`; `stale` = edited meanwhile, re-queued; `gone` = deleted meanwhile; `retry` = failed, will retry; `failed` = gave up after 3 tries) |
| `ai.answer` | An answer was written (provider, tokens, cost; always $0 with smart quotes) |
| `unhandled_error`, `answer_failed`, `meaning_search_failed`, `worker_loop_error` | Something failed; `err` has the message and stack |
| `api_listening`, `mongo_connected`, `backfill_*`, `atlas_index_*` | Startup |
| `shutting_down`, `stopped` | A deploy or restart |

Logs never contain note text, questions, search terms, tokens or keys. Embedding calls are logged at `debug` level (set `LOG_LEVEL=debug` to see them).

### Finding a request
Every response has an `X-Request-Id` header, and every error body includes `requestId`. Server errors in the app show "(Reference: 6d330520)": search the Render logs for those characters to find the request and its error.

## Error codes
Errors look like `{ "error": { "code", "message", "requestId", "details"? } }`.

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_FAILED` | 400 | The request body or query is wrong; `details` says which fields |
| `MALFORMED_JSON` | 400 | The body isn't valid JSON |
| `BAD_REQUEST` | 400 | Other invalid input |
| `UNAUTHORIZED` | 401 | No sign-in token, or it expired |
| `NOT_FOUND` | 404 | No such note, conversation or endpoint (or it belongs to someone else) |
| `CONFLICT` | 409 | E.g. a folder name already used |
| `PAYLOAD_TOO_LARGE` | 413 | Upload over 10 MB, or a body over 1 MB |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Upload type not supported |
| `UNPROCESSABLE` | 422 | The file is empty, damaged or has no readable text |
| `RATE_LIMITED` | 429 | Too many requests; `Retry-After` says how many seconds to wait |
| `QUOTA_EXCEEDED` | 429 | The user's daily AI budget is used up (resets at midnight UTC) |
| `SEMANTIC_UNAVAILABLE` | 503 | Search by meaning is down; keyword search still works |
| `INTERNAL` | 500 | A bug or outage: find the request id in the logs |

## Limits
| Limit | Default | Setting |
|---|---|---|
| Requests per user per minute | 300 | `RATE_LIMIT_PER_MINUTE` |
| Requests per IP per minute (before sign-in) | 600 | twice the above |
| Uploads and saved links per user per minute | 20 | 1/15 of the above |
| Suggestion requests per user per minute | 60 | 1/5 of the above |
| Questions per user per minute | 10 | fixed |
| AI tokens per user per day | 200,000 | `AI_DAILY_TOKEN_BUDGET` |

Limits are kept in memory, which is right for one API instance (the free plan runs one).

## Common tasks
**Rotate the Firebase service account key.** Firebase console → Project settings → Service accounts → Generate new private key. Put the new `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` in Render → Environment (the service restarts), then delete the old key in Google Cloud console → IAM → Service accounts.

**Rotate the database password.** Atlas → Database Access → edit the user → new password. Update `MONGODB_URI` in Render → Environment.

**Re-embed everything** (after changing the embedding model): run locally with the production `MONGODB_URI` in `apps/api/.env`:
```bash
npm run reembed -w apps/api
```
The worker on Render then processes the queue.

**Fill a demo account:** sign in once with the account, then:
```bash
npm run demo:seed -w apps/api -- --email you@example.com
```

**Restore data.** Free Atlas M0 clusters have no automatic backups. Export now and then with `mongodump --uri "<MONGODB_URI>"` (MongoDB Database Tools) and restore with `mongorestore`. Trashed notes are kept for 30 days and can be restored from the app's Trash.

**Roll back a bad deploy.** Render → the service → Events → pick the previous deploy → Rollback. Firebase Hosting → Release history → Roll back.
