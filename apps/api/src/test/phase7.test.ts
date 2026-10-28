import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { client, emulatorToken, startTestApi } from './helpers';

let api: Awaited<ReturnType<typeof startTestApi>>;
let A: ReturnType<typeof client>;
let B: ReturnType<typeof client>;
let limits: typeof import('../middleware/rate-limit').apiLimits;

before(async () => {
  api = await startTestApi();
  A = client(api.base, emulatorToken('p7-user-a'));
  B = client(api.base, emulatorToken('p7-user-b'));
  ({ apiLimits: limits } = await import('../middleware/rate-limit.js'));
});

after(async () => {
  await api?.stop();
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type ErrorBody = { error: { code: string; message: string; requestId: string; details?: unknown } };
const raw = (path: string, init: RequestInit = {}) => fetch(`${api.base}${path}`, init);

describe('Errors', () => {
  it('OPS-01 every error has the same shape: code, message and request id', async () => {
    const cases: [Promise<Response>, number, string][] = [
      [raw('/api/notes', { method: 'POST', headers: { Authorization: `Bearer ${emulatorToken('p7-user-a')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'poem' }) }), 400, 'VALIDATION_FAILED'],
      [raw('/api/notes', { method: 'POST', headers: { Authorization: `Bearer ${emulatorToken('p7-user-a')}`, 'Content-Type': 'application/json' }, body: '{oops' }), 400, 'MALFORMED_JSON'],
      [raw('/api/notes'), 401, 'UNAUTHORIZED'],
      [raw('/api/notes', { headers: { Authorization: 'Bearer not-a-token' } }), 401, 'UNAUTHORIZED'],
      [raw('/api/notes/6ae000000000000000000000', { headers: { Authorization: `Bearer ${emulatorToken('p7-user-a')}` } }), 404, 'NOT_FOUND'],
      [raw('/api/nothing-here'), 404, 'NOT_FOUND'],
    ];
    for (const [request, status, code] of cases) {
      const res = await request;
      const body = (await res.json()) as ErrorBody;
      assert.equal(res.status, status, JSON.stringify(body));
      assert.equal(body.error.code, code);
      assert.ok(body.error.message);
      assert.equal(body.error.requestId, res.headers.get('x-request-id'), 'body and header name the same request');
    }
    const invalid = (await (await raw('/api/notes', { method: 'POST', headers: { Authorization: `Bearer ${emulatorToken('p7-user-a')}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'poem' }) })).json()) as ErrorBody;
    assert.ok(invalid.error.details, 'validation errors say which fields are wrong');
  });

  it('OPS-08 a database failure during sign-in is a server error, not "session expired"', async () => {
    const { User } = await import('../models/User.js');
    const original = User.findOneAndUpdate;
    User.findOneAndUpdate = (() => Promise.reject(new Error('database unreachable'))) as unknown as typeof User.findOneAndUpdate;
    try {
      const r = await A.get('/api/folders');
      assert.equal(r.status, 500);
      assert.equal(r.body.error.code, 'INTERNAL');
      assert.ok(!JSON.stringify(r.body).includes('database unreachable'), 'internal details leaked');
    } finally {
      User.findOneAndUpdate = original;
    }
    assert.equal((await A.get('/api/folders')).status, 200);
  });
});

describe('Request ids', () => {
  it('OPS-02 every response carries an id; a valid incoming id is kept, anything else replaced', async () => {
    const fresh = await raw('/health');
    assert.match(fresh.headers.get('x-request-id') ?? '', UUID);
    const kept = await raw('/health', { headers: { 'X-Request-Id': 'edge-proxy-1234' } });
    assert.equal(kept.headers.get('x-request-id'), 'edge-proxy-1234');
    const replaced = await raw('/health', { headers: { 'X-Request-Id': '<script>alert(1)</script>' } });
    assert.match(replaced.headers.get('x-request-id') ?? '', UUID);
    // The browser app can read it (CORS), to show it on error screens.
    const cors = await raw('/health', { headers: { Origin: 'http://localhost:3000' } });
    assert.match(cors.headers.get('access-control-expose-headers') ?? '', /X-Request-Id/i);
  });
});

describe('Rate limits', () => {
  it('OPS-03 each user gets their own allowance; going over returns 429 with a retry time', async () => {
    const max = limits.user.options.max;
    limits.user.options.max = 3;
    limits.user.reset();
    try {
      for (let i = 0; i < 3; i++) assert.equal((await A.get('/api/folders')).status, 200);
      const over = await raw('/api/folders', { headers: { Authorization: `Bearer ${emulatorToken('p7-user-a')}` } });
      assert.equal(over.status, 429);
      assert.equal(((await over.json()) as ErrorBody).error.code, 'RATE_LIMITED');
      assert.ok(Number(over.headers.get('retry-after')) >= 1);
      assert.equal((await B.get('/api/folders')).status, 200, 'another user is not affected');
    } finally {
      limits.user.options.max = max;
      limits.user.reset();
    }
  });

  it('OPS-04 uploads and saved links have a stricter limit; so do requests before sign-in', async () => {
    const heavy = limits.heavy.options.max;
    limits.heavy.options.max = 1;
    limits.heavy.reset();
    try {
      await A.post('/api/notes/capture-url', { url: 'http://127.0.0.1/private' });
      const r = await A.post('/api/notes/capture-url', { url: 'http://127.0.0.1/private' });
      assert.equal(r.status, 429);
      assert.equal(r.body.error.code, 'RATE_LIMITED');
      assert.equal((await A.get('/api/folders')).status, 200, 'ordinary requests still work');
    } finally {
      limits.heavy.options.max = heavy;
      limits.heavy.reset();
    }

    const ip = limits.ip.options.max;
    limits.ip.options.max = 2;
    limits.ip.reset();
    try {
      await raw('/api/notes');
      await raw('/api/notes');
      const blocked = await raw('/api/notes');
      assert.equal(blocked.status, 429, 'token checks cannot be flooded');
      assert.equal((await raw('/health')).status, 200, 'health checks are never limited');
    } finally {
      limits.ip.options.max = ip;
      limits.ip.reset();
    }
  });
});

describe('Health and the worker', () => {
  it('OPS-05 /ready reports the database, worker and model, and fails while shutting down', async () => {
    const r = await raw('/ready');
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, db: 'up', worker: 'separate process', embeddingModel: 'fake' });

    const { lifecycle } = await import('../app.js');
    lifecycle.shuttingDown = true;
    try {
      const down = await raw('/ready');
      assert.equal(down.status, 503);
      assert.equal(((await down.json()) as { shuttingDown?: boolean }).shuttingDown, true);
    } finally {
      lifecycle.shuttingDown = false;
    }
  });

  it('OPS-06 the worker loop processes queued notes and stops cleanly between jobs', async () => {
    const worker = await import('../worker/loop.js');
    const created = await A.post('/api/notes', { title: 'Worker loop', content: 'Processed by the in-process worker loop.' });
    assert.equal(created.body.processing.status, 'pending');

    worker.startWorker();
    assert.equal(worker.workerRunning(), true);
    let status = 'pending';
    for (let i = 0; i < 200 && status !== 'ready'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = (await A.get(`/api/notes/${created.body._id}`)).body.processing.status;
    }
    assert.equal(status, 'ready');

    const started = Date.now();
    await worker.stopWorker();
    assert.equal(worker.workerRunning(), false);
    // Well under the 10 s back-off after an error, which it would otherwise sit out.
    assert.ok(Date.now() - started < 5000, 'an idle worker stops at once instead of finishing its wait');
  });
});

describe('Configuration', () => {
  it('OPS-07 the Firebase private key is accepted however it was pasted, and a wrong value is explained without echoing it', async () => {
    const { generateKeyPairSync, createPrivateKey } = await import('node:crypto');
    const { normalisePrivateKey } = await import('../config/private-key.js');
    const pem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const escaped = pem.trim().replace(/\n/g, '\n'); // as in the JSON file
    const pasted = [
      pem, // real line breaks
      escaped, // \n escapes
      `"${escaped}"`, // with the JSON quotes
      escaped.replace(/\n/g, '\\n'), // doubled escapes
      pem.replace(/\n/g, '\r\n'), // Windows line endings
      `  ${escaped}  `, // stray spaces
    ];
    for (const value of pasted) assert.doesNotThrow(() => createPrivateKey(normalisePrivateKey(value)));

    for (const wrong of ['firebase-adminsdk@demo.iam.gserviceaccount.com', '{"type":"service_account"}', 'secret-looking-value']) {
      assert.throws(() => normalisePrivateKey(wrong), (e: Error) => /BEGIN PRIVATE KEY/.test(e.message) && !e.message.includes(wrong));
    }
  });
});
