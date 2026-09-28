import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CLOCK, POOL } from '../src/config.js';
import { pooledTime } from '../src/deadline.js';
import { clientIp, createApp } from '../server/index.js';
import { PoolStore, validSubmission } from '../server/store.js';

/** The shared pool: what the server accepts, what it does with it, and what it hands back. */

const tempFile = async () => join(await mkdtemp(join(tmpdir(), 'untangle-pool-')), 'pool.json');

/** n runs spread evenly from `from` to `to` ms. */
const spread = (from, to, n) =>
  Array.from({ length: n }, (_, i) => Math.round(from + ((to - from) * i) / Math.max(1, n - 1)));

/** Starts the app on an ephemeral port and returns a fetch bound to it. */
async function serve(store) {
  const handler = createApp(store);
  const server = createServer((req, res) => {
    handler(req, res).catch(() => res.destroy());
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    call: (path, options) => fetch(`${base}${path}`, options),
    close: () => new Promise((done) => server.close(done)),
  };
}

// --- what gets in ----------------------------------------------------------------------

test('a plausible time is accepted and an implausible one is not', () => {
  assert.ok(validSubmission(5, 20000));
  assert.ok(!validSubmission(5, POOL.MIN_MS - 1), 'nobody cleared a stage that fast');
  assert.ok(!validSubmission(5, POOL.MAX_MS + 1), 'that was a tab left open');
  assert.ok(!validSubmission(0, 20000), 'there is no stage zero');
  assert.ok(!validSubmission(POOL.MAX_STAGE + 1, 20000));
  assert.ok(!validSubmission(1.5, 20000), 'stages are whole numbers');
  for (const bad of [NaN, Infinity, '20000', null, undefined, {}]) {
    assert.ok(!validSubmission(5, bad), `rejects ${String(bad)}`);
  }
});

test('the bounds hold on an empty pool, where the statistics cannot', () => {
  // The clamp needs a populated stage to judge against, so on the very first submission
  // the hard bounds are the only thing there is. This is the case that matters.
  const store = new PoolStore('/dev/null');
  assert.equal(store.submit(1, 5), null);
  assert.equal(store.submit(1, 20000), 20000);
});

test('a forged time is pulled back toward the stage rather than taken', () => {
  const store = new PoolStore('/dev/null');
  for (const ms of spread(19000, 21000, 40)) store.submit(9, ms);

  const before = pooledTime(9, store.stages);
  const stored = store.submit(9, POOL.MIN_MS);
  assert.ok(stored > POOL.MIN_MS * 3, `clamped up to ${stored}`);

  // The single worst case for a pooled model: one player submits an impossible time and
  // every other player inherits it as their deadline. It has to barely move the par.
  const after = pooledTime(9, store.stages);
  assert.ok(Math.abs(after - before) < before * 0.05, `par moved ${before} -> ${after}`);
});

test('a sustained poisoning attempt still cannot drag a stage to nothing', () => {
  const store = new PoolStore('/dev/null');
  for (const ms of spread(19000, 21000, 60)) store.submit(9, ms);
  const honest = pooledTime(9, store.stages);

  // Every submission the rate limit would allow in a minute, all of them the fastest the
  // bounds permit. The clamp is relative to a mean the attacker is also moving, so this
  // walks the pool down rather than dropping it — the point is that it stays sane.
  for (let i = 0; i < POOL.RATE_LIMIT; i++) store.submit(9, POOL.MIN_MS);
  const poisoned = pooledTime(9, store.stages);
  assert.ok(poisoned > 0 && Number.isFinite(poisoned));
  assert.ok(poisoned < honest, 'it does move — pooling from strangers is a trust decision');
  assert.ok(poisoned > POOL.MIN_MS, `never reaches the floor it was aiming at: ${poisoned}`);
});

test('the ring is bounded, oldest out first', () => {
  const store = new PoolStore('/dev/null');
  for (let i = 0; i < POOL.SERVER_KEEP + 50; i++) store.submit(3, 20000);
  assert.equal(store.stages['3'].length, POOL.SERVER_KEEP);
  assert.equal(store.counts['3'], POOL.SERVER_KEEP + 50, 'the lifetime count is not bounded');
});

// --- what comes back -------------------------------------------------------------------

test('the par table is one number per stage, already trimmed and sliced', () => {
  const store = new PoolStore('/dev/null');
  for (const ms of spread(18000, 22000, 30)) store.submit(4, ms);

  const pars = store.pars();
  assert.deepEqual(Object.keys(pars), ['4']);
  assert.equal(pars['4'].ms, Math.round(pooledTime(4, store.stages)));
  assert.equal(pars['4'].n, 30);
});

test('a stage with no times has no par rather than a zero one', () => {
  assert.deepEqual(new PoolStore('/dev/null').pars(), {});
});

test('the table is cached between reads and rebuilt after a write', () => {
  // GET /api/pars is unauthenticated and sorts every sample of every stage, so rebuilding
  // it per request made the cheapest thing to ask for the most expensive thing to answer.
  const store = new PoolStore('/dev/null');
  for (const ms of spread(18000, 22000, 20)) store.submit(4, ms);

  const first = store.pars();
  assert.equal(store.pars(), first, 'same object — not rebuilt');

  store.submit(4, 21000);
  const rebuilt = store.pars();
  assert.notEqual(rebuilt, first, 'a submission invalidates it');
  assert.notEqual(rebuilt['4'].ms, first['4'].ms, 'and the new par really is different');
  assert.equal(rebuilt['4'].n, 21, 'the count moved with it');
});

test('a store written by a newer server is refused rather than misread', async () => {
  // The version used to be written and never read, so the next schema change would have
  // been a silent misreading of the old shape rather than a decision.
  const file = await tempFile();
  await writeFile(file, JSON.stringify({ v: 99, stages: { 5: [20000] }, counts: { 5: 1 } }));

  const store = await new PoolStore(file).load();
  assert.deepEqual(Object.keys(store.stages), [], 'not loaded as if it were v1');
});

test('a store with no version is read as the first one', async () => {
  const file = await tempFile();
  await writeFile(file, JSON.stringify({ stages: { 5: [20000] } }));
  const store = await new PoolStore(file).load();
  assert.deepEqual(store.stages['5'], [20000]);
});

// --- persistence -----------------------------------------------------------------------

test('a pool survives a restart', async () => {
  const file = await tempFile();
  const store = new PoolStore(file);
  for (const ms of spread(18000, 22000, 12)) store.submit(6, ms);
  await store.flush();

  const reloaded = await new PoolStore(file).load();
  assert.deepEqual(reloaded.stages['6'], store.stages['6']);
  assert.equal(reloaded.counts['6'], 12);
});

test('a corrupt or missing store comes up empty rather than not coming up', async () => {
  const file = await tempFile();
  // Object.keys rather than deepEqual against {}: the stores are null-prototype objects,
  // which deepStrictEqual counts as different from a plain one.
  assert.deepEqual(Object.keys((await new PoolStore(file).load()).stages), [], 'missing');

  await writeFile(file, '{"stages": truncated');
  assert.deepEqual(Object.keys((await new PoolStore(file).load()).stages), [], 'corrupt');

  // Hand-edited junk in an otherwise valid file is dropped entry by entry.
  await writeFile(file, JSON.stringify({ stages: { 5: [1000, 'x', -4, null], no: [1] } }));
  const salvaged = await new PoolStore(file).load();
  assert.deepEqual(Object.keys(salvaged.stages), ['5']);
  assert.deepEqual(salvaged.stages['5'], [1000]);
});

test('close waits for a write already in flight', async () => {
  // The shutdown path is close().finally(() => process.exit(0)). close() used to see the
  // in-flight write had already cleared `dirty`, return immediately, and let the exit kill
  // the write — losing every submission inside the debounce window on each restart.
  const file = await tempFile();
  const store = new PoolStore(file);
  store.submit(3, 20000);

  const inFlight = store.flush(); // the debounced timer, not awaited by anyone
  await store.close(); // process.exit(0) would fire here

  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(onDisk.stages['3'], [20000], 'on disk by the time close() resolved');
  await inFlight;
});

test('a write that fails is retried rather than discarded', async () => {
  // `dirty` used to be cleared before the write, so a full disk or a permissions change
  // dropped the pool silently and every later flush and close() no-opped.
  const store = new PoolStore('/nonexistent-root-dir/nope/pool.json');
  store.submit(4, 21000);

  await assert.rejects(() => store.flush(), 'the failure is reported');
  assert.equal(store.dirty, true, 'and the data is still pending, not lost');

  // Pointed somewhere writable, the same store still has everything.
  store.file = await tempFile();
  await store.close();
  assert.deepEqual(JSON.parse(await readFile(store.file, 'utf8')).stages['4'], [21000]);
});

test('overlapping flushes serialise, and the last one wins', async () => {
  const file = await tempFile();
  const store = new PoolStore(file);

  // Three writes started without awaiting, each with more in the store than the last.
  store.submit(5, 20000);
  const a = store.flush();
  store.submit(5, 21000);
  const b = store.flush();
  store.submit(6, 30000);
  const c = store.flush();
  await Promise.all([a, b, c]);

  // Serialised rather than racing on the shared temp path, so the file parses and holds
  // everything submitted — not whichever write happened to rename last.
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(onDisk.stages['5'], [20000, 21000]);
  assert.deepEqual(onDisk.stages['6'], [30000]);
  assert.equal(store.dirty, false, 'nothing left pending');
});

test('the write is atomic — a reader never sees a half-written pool', async () => {
  const file = await tempFile();
  const store = new PoolStore(file);
  store.submit(2, 20000);
  await store.flush();
  // Whatever is at the path parses, because it arrived there by rename.
  assert.ok(JSON.parse(await readFile(file, 'utf8')).stages['2']);
});

// --- the API ---------------------------------------------------------------------------

test('GET /api/pars serves the table, and lets it be cached', async () => {
  const store = new PoolStore('/dev/null');
  for (const ms of spread(18000, 22000, 20)) store.submit(7, ms);
  const app = await serve(store);

  try {
    const res = await app.call('/api/pars');
    assert.equal((await res.json()).pars['7'].ms, Math.round(pooledTime(7, store.stages)));
    assert.match(res.headers.get('cache-control'), /max-age=\d+/, 'a proxy may answer for us');
  } finally {
    await app.close();
  }
});

test('the read is rate-limited too, not just the write', async () => {
  const store = new PoolStore('/dev/null');
  const app = await serve(store);

  try {
    // Reads and writes share one budget, so spending it on reads closes the write path too.
    for (let i = 0; i < POOL.RATE_LIMIT; i++) await app.call('/api/pars');
    assert.equal((await app.call('/api/pars')).status, 429);
  } finally {
    await app.close();
  }
});

test('POST /api/times files one time and a batch of them', async () => {
  const store = new PoolStore('/dev/null');
  const app = await serve(store);
  const post = (body) =>
    app.call('/api/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  try {
    assert.deepEqual(await (await post({ stage: 8, ms: 20000 })).json(), {
      stored: 1,
      received: 1,
    });

    // The offline outbox arrives as a batch, which is the only reason the array form
    // exists — a round trip per stranded time would be silly.
    const batch = await (
      await post({ times: [{ stage: 8, ms: 21000 }, { stage: 9, ms: 30000 }] })
    ).json();
    assert.deepEqual(batch, { stored: 2, received: 2 });
    assert.equal(store.stages['8'].length, 2);
    assert.equal(store.stages['9'].length, 1);

    // A completely full outbox has to fit. It did not at one point — the body limit was a
    // flat kilobyte and fifty entries are about fifteen hundred bytes — and the client it
    // would have turned away is the one that has been offline longest.
    const full = Array.from({ length: POOL.OUTBOX_MAX }, () => ({ stage: 11, ms: 123456 }));
    const drained = await post({ times: full });
    assert.equal(drained.status, 200, 'a maximum outbox is not too large to send');
    assert.deepEqual(await drained.json(), { stored: POOL.OUTBOX_MAX, received: POOL.OUTBOX_MAX });
  } finally {
    await app.close();
  }
});

test('a rejected time is counted, not an error — the client cannot fix it', async () => {
  const store = new PoolStore('/dev/null');
  const app = await serve(store);

  try {
    const res = await app.call('/api/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ times: [{ stage: 8, ms: 5 }, { stage: 8, ms: 20000 }] }),
    });
    assert.equal(res.status, 200, 'so the outbox clears rather than retrying forever');
    assert.deepEqual(await res.json(), { stored: 1, received: 2 });
  } finally {
    await app.close();
  }
});

test('malformed requests are refused without taking the server down', async () => {
  const store = new PoolStore('/dev/null');
  const app = await serve(store);
  const post = (body) =>
    app.call('/api/times', { method: 'POST', headers: { 'content-type': 'application/json' }, body });

  try {
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post(JSON.stringify({ times: 'nope' }))).status, 200, 'treated as one entry');
    assert.equal((await post('x'.repeat(64 * 1024))).status, 413, 'and it answers rather than resetting');
    assert.equal((await app.call('/api/nope')).status, 404);
    assert.equal((await app.call('/api/pars', { method: 'POST' })).status, 404);
    assert.deepEqual(Object.keys(store.stages), [], 'and nothing got in');
  } finally {
    await app.close();
  }
});

test('the rate limit lets a session through and stops a loop', () => {
  const store = new PoolStore('/dev/null');
  const now = 1_000_000;
  for (let i = 0; i < POOL.RATE_LIMIT; i++) {
    assert.ok(store.allow('1.2.3.4', now), `submission ${i} allowed`);
  }
  assert.ok(!store.allow('1.2.3.4', now), 'and then it stops');
  assert.ok(store.allow('5.6.7.8', now), 'one client stuck does not lock anybody else out');
  assert.ok(store.allow('1.2.3.4', now + POOL.RATE_WINDOW_MS), 'the window reopens');
});

// --- static serving --------------------------------------------------------------------

test('the game is served, and the page can reach everything it asks for', async () => {
  // Against the real build, and deliberately following the page's own references rather
  // than a list of filenames written here: the bundle and the stylesheet carry content
  // hashes, so a hardcoded path would be a test that has to be edited on every build.
  const app = await serve(new PoolStore('/dev/null'));

  try {
    const page = await app.call('/');
    assert.equal(page.status, 200, 'run `npm run build` — the server serves dist/');
    assert.match(page.headers.get('content-type'), /text\/html/);

    const html = await page.text();
    assert.match(html, /<canvas id="canvas">/, 'the board');
    assert.match(html, /<u-hud>/, 'and the components over it');

    const script = html.match(/<script[^>]+src="\.?([^"]+)"/);
    assert.ok(script, 'the page should load a module');
    const bundle = await app.call(script[1]);
    assert.equal(bundle.status, 200);
    assert.match(bundle.headers.get('content-type'), /javascript/);
    assert.match(
      bundle.headers.get('cache-control'),
      /immutable/,
      'a content-hashed asset can be cached forever',
    );

    const link = html.match(/<link[^>]+href="\.?([^"]+\.css)"/);
    assert.ok(link, 'and a stylesheet');
    const css = await app.call(link[1]);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);

    // The one file that must never be cached: it is what names the hashes above, so a
    // browser holding on to it pins itself to the previous release.
    assert.match(page.headers.get('cache-control'), /no-cache/);
  } finally {
    await app.close();
  }
});

test('and the rest of the checkout is not', async () => {
  const app = await serve(new PoolStore('/dev/null'));

  try {
    // The server's tree is `dist`, which holds the built game and nothing else — so the
    // checkout is not merely disallowed, it is not in the tree at all. What still has to
    // hold is that nothing climbs out of it: note that /../package.json is not even a
    // traversal by the time it arrives, because new URL() normalises it to /package.json.
    const forbidden = [
      '/package.json',
      '/../package.json',
      '/..%2Fpackage.json',
      '/.git/config',
      '/server/store.js',
      '/test/pool.test.js',
      '/src/game.js',
      '/src/../package.json',
      '/src/../../etc/passwd',
      '/../src/ui/hud/hud.ts',
      '/tsconfig.json',
    ];

    for (const path of forbidden) {
      const res = await app.call(path);
      assert.ok(res.status === 403 || res.status === 404, `${path} -> ${res.status}`);
      const body = await res.text();
      assert.ok(!body.includes('"untangle"'), `${path} leaked package.json`);
      assert.ok(!body.includes('root:'), `${path} leaked a system file`);
      assert.ok(!body.includes('PoolStore'), `${path} leaked server source`);
    }
  } finally {
    await app.close();
  }
});

// --- the knobs -------------------------------------------------------------------------

test('the pool window is longer than the personal one, and both are real', () => {
  // Not a tautology: POOL.SERVER_KEEP being accidentally set to CLOCK.KEEP would make the
  // pooled percentile as jumpy as a single player's history and nothing would fail.
  assert.ok(POOL.SERVER_KEEP > CLOCK.KEEP * 10);
  assert.ok(POOL.MIN_MS > 0 && POOL.MAX_MS > POOL.MIN_MS);
});

// --- one request cannot walk the clamp down ------------------------------------------------

test('a batch is clamped against the pool as it stood before the batch', async () => {
  // Filed one at a time, each entry is pulled to a quarter of a mean the entries before it
  // have already lowered, and fifty of them take a stage from a minute to a few seconds in
  // one request. Judged against one snapshot, the batch can only move the par as far as a
  // single forged entry could.
  const store = new PoolStore('/dev/null');
  for (const ms of spread(58000, 62000, 5)) store.submit(9, ms);
  const before = pooledTime(9, store.stages);
  // The clamp judges against the trimmed mean, not the quoted par.
  const floor = store.typical(9) / CLOCK.OUTLIER;
  const app = await serve(store);

  try {
    const times = Array.from({ length: 40 }, () => ({ stage: 9, ms: POOL.MIN_MS }));
    const res = await app.call('/api/times', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ times }),
    });
    assert.equal(res.status, 200);

    assert.ok(
      store.stages['9'].slice(-40).every((ms) => ms >= floor - 1),
      'every entry was clamped against the same figure',
    );
    // Forty forged entries against five honest ones do move the par, but only as far as
    // the clamp allows a single entry to go: filed one at a time they reached six seconds.
    assert.ok(pooledTime(9, store.stages) >= floor - 1, 'the par stops at the clamp floor');
    assert.ok(pooledTime(9, store.stages) < before, 'it is not pretending nothing happened');
  } finally {
    await app.close();
  }
});

test('a batch spends the rate limit per entry, not per request', async () => {
  const store = new PoolStore('/dev/null');
  const app = await serve(store);

  try {
    const post = (times) =>
      app.call('/api/times', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ times }),
      });
    const batch = (n) => Array.from({ length: n }, () => ({ stage: 3, ms: 20000 }));

    // One request of 50 and one of 9 is exactly the budget; the next entry is over it.
    assert.equal((await post(batch(POOL.OUTBOX_MAX))).status, 200);
    assert.equal((await post(batch(POOL.RATE_LIMIT - POOL.OUTBOX_MAX - 1))).status, 200);
    assert.equal((await post(batch(2))).status, 429, 'fifty-one entries in a minute is too many');
  } finally {
    await app.close();
  }
});

test('behind a proxy the client address is the entry the proxy appended', () => {
  // Each proxy appends the address it saw, so the entries to the left of the trusted ones
  // are whatever the client chose to send. Reading the first entry, as this used to, let a
  // client pick its own rate-limit bucket on every request.
  const previous = process.env.UNTANGLE_TRUST_PROXY;
  const ip = (hops, header) => {
    process.env.UNTANGLE_TRUST_PROXY = hops;
    return clientIp({ headers: { 'x-forwarded-for': header }, socket: { remoteAddress: '10.0.0.1' } });
  };
  try {
    assert.equal(ip('1', 'forged, 203.0.113.7'), '203.0.113.7');
    assert.equal(ip('2', 'forged, 203.0.113.7, 198.51.100.2'), '203.0.113.7', 'two hops, second from the right');
    assert.equal(ip('1', ''), '10.0.0.1', 'no header, the socket');
    assert.equal(ip('', 'forged'), '10.0.0.1', 'not trusting the header at all');
    // Fewer entries than trusted proxies is a chain the proxies did not build, so nothing
    // in it is trusted and the socket address stands.
    assert.equal(ip('3', 'a, b'), '10.0.0.1', 'a short chain is not read at all');
  } finally {
    if (previous === undefined) delete process.env.UNTANGLE_TRUST_PROXY;
    else process.env.UNTANGLE_TRUST_PROXY = previous;
  }
});
