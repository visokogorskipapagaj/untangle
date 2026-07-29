import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { POOL } from '../src/config.js';
import { Pool } from '../src/pool.js';
import { createApp } from '../server/index.js';
import { PoolStore } from '../server/store.js';

/**
 * The client's half of the pool, against the real server.
 *
 * Everything here is about the failure path, because the happy one is one fetch. What the
 * game actually needs from this module is that a dead server, a slow one and a hostile one
 * are all indistinguishable from not having a pool at all.
 */

/** Enough localStorage for the module: it only ever gets, sets, and catches. */
function stubStorage() {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
  return map;
}

async function serve(store = new PoolStore('/dev/null')) {
  const handler = createApp(store);
  const server = createServer((req, res) => {
    handler(req, res).catch(() => res.destroy());
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    store,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** A port with nothing on it. Connection refused is the fast, honest offline case. */
const DEAD_URL = 'http://127.0.0.1:1';

// --- fetching the table ----------------------------------------------------------------

test('sync brings back a table the deadline model can read', async () => {
  stubStorage();
  const app = await serve();
  for (let i = 0; i < 20; i++) app.store.submit(4, 20000 + i * 100);

  try {
    const pool = new Pool({ baseUrl: app.baseUrl });
    assert.deepEqual(pool.pars, {}, 'nothing before the first sync');

    await pool.sync();
    assert.equal(typeof pool.pars['4'], 'number', 'stage -> ms, which is what stageDeadline wants');
    assert.ok(pool.pars['4'] > 0);
  } finally {
    await app.close();
  }
});

test('a dead server leaves the game exactly as it was without one', async () => {
  stubStorage();
  const pool = new Pool({ baseUrl: DEAD_URL });
  await pool.sync(); // must not throw — nothing awaits this in main.js
  assert.deepEqual(pool.pars, {}, 'and an empty table is the pre-pool behaviour');
});

test('the cached table survives a reload and is used before the network answers', async () => {
  stubStorage();
  const app = await serve();
  for (let i = 0; i < 20; i++) app.store.submit(4, 20000 + i * 100);

  try {
    await new Pool({ baseUrl: app.baseUrl }).sync();
    // A new session, same storage: the table is there at construction, before any await.
    const reloaded = new Pool({ baseUrl: app.baseUrl });
    assert.ok(reloaded.pars['4'] > 0, 'the first board of the session already has a par');
  } finally {
    await app.close();
  }
});

test('a stale cache is kept when the refresh fails', async () => {
  stubStorage();
  const app = await serve();
  for (let i = 0; i < 20; i++) app.store.submit(4, 20000 + i * 100);

  try {
    await new Pool({ baseUrl: app.baseUrl }).sync();
  } finally {
    await app.close();
  }

  // Same storage, server now gone, and the cache aged past MAX_AGE_MS so a refresh is
  // attempted and fails. A stale par is a better deadline than none.
  const offline = new Pool({ baseUrl: DEAD_URL, now: () => Date.now() + POOL.MAX_AGE_MS * 2 });
  assert.ok(offline.stale);
  const before = offline.pars['4'];
  await offline.sync();
  assert.equal(offline.pars['4'], before, 'kept, not cleared');
});

test('a garbage response cannot produce a NaN deadline', async () => {
  stubStorage();
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ pars: { 4: { ms: 'soon' }, 5: { ms: -1 }, six: { ms: 100 } } }));
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));

  try {
    const pool = new Pool({ baseUrl: `http://127.0.0.1:${server.address().port}` });
    await pool.sync();
    assert.deepEqual(pool.pars, {}, 'every malformed entry dropped');
  } finally {
    await new Promise((done) => server.close(done));
  }
});

// --- contributing ----------------------------------------------------------------------

test('a clear reaches the pool and leaves nothing behind', async () => {
  stubStorage();
  const app = await serve();

  try {
    const pool = new Pool({ baseUrl: app.baseUrl });
    pool.submit(5, 20000.7);
    await new Promise((done) => setTimeout(done, 100));

    assert.deepEqual(pool.outbox, [], 'sent and cleared');
    assert.deepEqual(app.store.stages['5'], [20001], 'rounded on the way out');
  } finally {
    await app.close();
  }
});

test('a clear with nowhere to go is held, and goes with the next one', async () => {
  const storage = stubStorage();
  const offline = new Pool({ baseUrl: DEAD_URL });
  offline.submit(5, 20000);
  await new Promise((done) => setTimeout(done, 100));

  assert.deepEqual(offline.outbox, [{ stage: 5, ms: 20000 }], 'held');
  assert.ok(storage.get(POOL.OUTBOX_KEY).includes('20000'), 'and written down, so a reload keeps it');

  // The server comes back, and the next session drains what the last one stranded.
  const app = await serve();
  try {
    const online = new Pool({ baseUrl: app.baseUrl });
    assert.equal(online.outbox.length, 1, 'picked up from storage at construction');
    online.submit(6, 30000);
    await new Promise((done) => setTimeout(done, 100));

    assert.deepEqual(online.outbox, []);
    assert.deepEqual(app.store.stages['5'], [20000], 'the stranded one arrived too');
    assert.deepEqual(app.store.stages['6'], [30000]);
  } finally {
    await app.close();
  }
});

test('sync drains a stranded outbox even when the table is fresh', async () => {
  stubStorage();
  const offline = new Pool({ baseUrl: DEAD_URL });
  offline.submit(5, 20000);
  await new Promise((done) => setTimeout(done, 100));

  const app = await serve();
  try {
    // now() pinned so the table is never stale — the drain must not be conditional on it.
    const pool = new Pool({ baseUrl: app.baseUrl, now: () => 0 });
    pool.fetchedAt = 0;
    assert.ok(!pool.stale);
    await pool.sync();
    assert.deepEqual(app.store.stages['5'], [20000]);
  } finally {
    await app.close();
  }
});

test('a long offline run does not grow the outbox without limit', async () => {
  stubStorage();
  const pool = new Pool({ baseUrl: DEAD_URL });
  for (let i = 0; i < POOL.OUTBOX_MAX + 20; i++) pool.submit(i + 1, 20000);
  await new Promise((done) => setTimeout(done, 150));

  assert.equal(pool.outbox.length, POOL.OUTBOX_MAX);
  // Oldest out first, so what survives is the most recent play rather than the first.
  assert.equal(pool.outbox.at(-1).stage, POOL.OUTBOX_MAX + 20);
});

test('a time the server judges implausible is not retried forever', async () => {
  stubStorage();
  const app = await serve();

  try {
    const pool = new Pool({ baseUrl: app.baseUrl });
    pool.submit(5, 1); // below POOL.MIN_MS, so the server files nothing
    await new Promise((done) => setTimeout(done, 100));

    assert.deepEqual(pool.outbox, [], 'cleared on a 2xx whatever the server made of it');
    assert.equal(app.store.stages['5'], undefined);
  } finally {
    await app.close();
  }
});
