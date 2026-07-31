import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { ANALYTICS } from '../src/config.js';
import { createApp } from '../server/index.js';
import { PostHogStats, QUERIES, fromEnv, stats } from '../server/stats.js';
import { PoolStore } from '../server/store.js';

/**
 * The PostHog stats reader.
 *
 * Everything here is a failure case, because the happy path is three fetches. What the
 * project actually needs from this module is that a missing key, a rejected key, a rate
 * limit and a project with no traffic are all survivable, and that none of them can put a
 * confident wrong number in front of a player.
 */

/** `stats` is a mutated singleton, so every test has to start from a known one. */
function resetStats() {
  stats.totalVisitors = null;
  stats.currentVisitors = null;
  stats.avgSessionSeconds = null;
  stats.fetchedAt = 0;
}

/**
 * A stand-in for PostHog that answers each of the three queries from `answers`, keyed by
 * the stats field the query feeds. A missing key means that query fails.
 */
function stubFetch(answers, calls = []) {
  return async (url, options) => {
    const { query } = JSON.parse(options.body);
    const name = Object.keys(QUERIES).find((key) => QUERIES[key] === query.query);
    calls.push({ url, name, auth: options.headers.authorization });

    if (!(name in answers)) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ results: [[answers[name]]] }) };
  };
}

function reader(answers, calls) {
  return new PostHogStats({
    host: 'https://us.i.posthog.com',
    projectId: '12345',
    apiKey: 'phx_test',
    now: () => 1000,
    fetch: stubFetch(answers, calls),
  });
}

// --- the numbers -------------------------------------------------------------------------

test('a refresh puts all three numbers in the variable', async () => {
  resetStats();
  await reader({ totalVisitors: 4210, currentVisitors: 7, avgSessionSeconds: 312.5 }).refresh();

  assert.equal(stats.totalVisitors, 4210);
  assert.equal(stats.currentVisitors, 7);
  assert.equal(stats.avgSessionSeconds, 312.5);
  assert.equal(stats.fetchedAt, 1000, 'stamped, so freshness is readable');
});

test('the personal key goes in the Authorization header and the project id in the path', async () => {
  resetStats();
  const calls = [];
  await reader({ totalVisitors: 1, currentVisitors: 1, avgSessionSeconds: 1 }, calls).refresh();

  assert.equal(calls.length, 3, 'one query per number');
  for (const call of calls) {
    assert.equal(call.auth, 'Bearer phx_test');
    assert.equal(call.url, 'https://us.i.posthog.com/api/projects/12345/query/');
  }
});

test('counts arriving as strings are still numbers by the time anything reads them', async () => {
  resetStats();
  await reader({ totalVisitors: '99999', currentVisitors: 3, avgSessionSeconds: '61.25' }).refresh();

  assert.equal(stats.totalVisitors, 99999);
  assert.equal(stats.avgSessionSeconds, 61.25);
});

// --- failing without lying ---------------------------------------------------------------

test('one failed query does not discard the two that answered', async () => {
  resetStats();
  // `sessions` is empty on a fresh project long after events are flowing; the visitor
  // counts must survive that rather than going down with it.
  await reader({ totalVisitors: 500, currentVisitors: 2 }).refresh();

  assert.equal(stats.totalVisitors, 500);
  assert.equal(stats.currentVisitors, 2);
  assert.equal(stats.avgSessionSeconds, null, 'absent, not zero');
  assert.equal(stats.fetchedAt, 1000, 'something landed, so it is fresh');
});

test('a total outage keeps the last known numbers rather than clearing them', async () => {
  resetStats();
  await reader({ totalVisitors: 500, currentVisitors: 2, avgSessionSeconds: 90 }).refresh();

  const dead = new PostHogStats({
    projectId: '12345',
    apiKey: 'phx_test',
    now: () => 9999,
    fetch: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  await dead.refresh(); // must not throw — nothing awaits this in start()

  assert.equal(stats.totalVisitors, 500, 'kept');
  assert.equal(stats.currentVisitors, 2);
  assert.equal(stats.fetchedAt, 1000, 'and not restamped, so staleness is visible');
});

test('a null average leaves the previous one alone', async () => {
  resetStats();
  await reader({ totalVisitors: 1, currentVisitors: 1, avgSessionSeconds: 120 }).refresh();
  // avg() over no rows is null in ClickHouse. That is "no answer", not "sessions are 0s long".
  await reader({ totalVisitors: 2, currentVisitors: 1, avgSessionSeconds: null }).refresh();

  assert.equal(stats.avgSessionSeconds, 120);
  assert.equal(stats.totalVisitors, 2, 'while the ones that did answer still moved');
});

test('a garbage response cannot put a NaN in front of a player', async () => {
  resetStats();
  const junk = new PostHogStats({
    projectId: '12345',
    apiKey: 'phx_test',
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ results: [['soon']] }) }),
  });
  await junk.refresh();

  assert.equal(stats.totalVisitors, null);
  assert.equal(stats.fetchedAt, 0, 'nothing landed, so nothing is claimed');
});

// --- no account at all -------------------------------------------------------------------

test('an unconfigured reader is inert rather than fatal', async () => {
  resetStats();
  const bare = fromEnv({});
  assert.equal(bare.configured, false);

  await bare.refresh(); // the game has to be playable without a PostHog account
  assert.equal(bare.start().timer, null, 'and starts no timer to fail on a loop');
  assert.equal(stats.fetchedAt, 0);
});

test('a project id without a key is not enough to try', () => {
  assert.equal(fromEnv({ POSTHOG_PROJECT_ID: '12345' }).configured, false);
  assert.equal(fromEnv({ POSTHOG_PERSONAL_API_KEY: 'phx_x' }).configured, false);
  assert.equal(
    fromEnv({ POSTHOG_PROJECT_ID: '12345', POSTHOG_PERSONAL_API_KEY: 'phx_x' }).configured,
    true,
  );
});

test('a host with a trailing slash still builds a reachable URL', () => {
  const trailing = new PostHogStats({
    host: 'https://eu.i.posthog.com/',
    projectId: '7',
    apiKey: 'phx_x',
  });
  assert.equal(trailing.endpoint, 'https://eu.i.posthog.com/api/projects/7/query/');
});

// --- over the wire -----------------------------------------------------------------------

async function serve() {
  const handler = createApp(new PoolStore('/dev/null'));
  const server = createServer((req, res) => {
    handler(req, res).catch(() => res.destroy());
  });
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

test('/api/stats serves the numbers and never the key that fetched them', async () => {
  resetStats();
  await reader({ totalVisitors: 4210, currentVisitors: 7, avgSessionSeconds: 312.5 }).refresh();

  const app = await serve();
  try {
    const response = await fetch(`${app.baseUrl}/api/stats`);
    assert.equal(response.status, 200);
    assert.equal(
      response.headers.get('cache-control'),
      `public, max-age=${ANALYTICS.STATS_MAX_AGE_S}`,
    );

    const body = await response.json();
    assert.deepEqual(body, {
      totalVisitors: 4210,
      currentVisitors: 7,
      avgSessionSeconds: 312.5,
      fetchedAt: 1000,
      live: true,
    });
    assert.ok(!JSON.stringify(body).includes('phx_'), 'the personal key stays on the server');
  } finally {
    await app.close();
  }
});

test('/api/stats says so rather than guessing when PostHog has never answered', async () => {
  resetStats();
  const app = await serve();
  try {
    const body = await (await fetch(`${app.baseUrl}/api/stats`)).json();
    assert.equal(body.live, false, 'so a caller can tell a misconfiguration from an empty project');
    assert.equal(body.totalVisitors, null, 'and never a confident 0');
  } finally {
    await app.close();
  }
});
