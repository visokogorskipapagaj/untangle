import { ANALYTICS } from '../src/config.js';
import { QUERIES, fromEnv } from './stats.js';

/**
 * `npm run stats` — does the PostHog half actually work?
 *
 * The server deliberately swallows every query failure: a rate limit, a rejected key and an
 * empty project all leave the numbers alone and say nothing, because a game must not break
 * over analytics. That is right in production and useless when setting the thing up, which
 * is what this is for — it runs the same three queries against the same endpoint and reports
 * what came back, including the part `refresh()` throws away.
 *
 * Read-only. It asks PostHog three questions and writes nothing anywhere.
 */

const reader = fromEnv();

/** Enough to prove the right key is loaded, never enough to leak it. */
const fingerprint = (key) =>
  key ? `${key.slice(0, 4)}…${key.slice(-4)} (${key.length} chars)` : '(unset)';

console.log(`host        ${reader.host}`);
console.log(`project     ${reader.projectId || '(unset)'}`);
console.log(`personal key ${fingerprint(reader.apiKey)}`);
console.log();

if (!reader.configured) {
  console.error('Not configured. POSTHOG_PROJECT_ID and POSTHOG_PERSONAL_API_KEY must both be set');
  console.error('in .env (copy .env.example). /api/stats will serve nulls until they are.');
  process.exit(1);
}

/**
 * One query, reported rather than swallowed.
 *
 * The error body is printed because PostHog's are genuinely diagnostic — a wrong scope, a
 * wrong region and an unknown column each say so plainly, and each is a different fix.
 */
async function check(name, hogql) {
  process.stdout.write(`${name.padEnd(20)}`);
  try {
    const response = await fetch(reader.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${reader.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
      signal: AbortSignal.timeout(ANALYTICS.TIMEOUT_MS),
    });

    const text = await response.text();
    if (!response.ok) {
      console.log(`FAILED  HTTP ${response.status}`);
      console.log(`  ${text.slice(0, 400)}`);
      if (response.status === 401) {
        console.log('  -> a personal key (phx_…) with the "query read" scope, not the phc_ one');
      }
      if (response.status === 404) {
        console.log(`  -> wrong project id, or POSTHOG_HOST is the ingest host; the query API`);
        console.log(`     is on the app host (${ANALYTICS.DEFAULT_API_HOST})`);
      }
      return false;
    }

    const value = JSON.parse(text)?.results?.[0]?.[0];
    console.log(value === null || value === undefined ? 'null (no data yet)' : String(value));
    return true;
  } catch (err) {
    console.log(`FAILED  ${err.message}`);
    return false;
  }
}

let ok = true;
for (const [name, hogql] of Object.entries(QUERIES)) {
  ok = (await check(name, hogql)) && ok;
}

console.log();
if (ok) {
  console.log('All three queries answered. /api/stats will serve these once the server runs.');
  console.log('A null means the query is valid and the project has no data for it yet —');
  console.log('load the game once and re-run; PostHog takes a minute or two to ingest.');
} else {
  console.log('Something above failed. The game is unaffected — /api/stats keeps serving');
  console.log('nulls and every other endpoint is untouched.');
}
process.exit(ok ? 0 : 1);
