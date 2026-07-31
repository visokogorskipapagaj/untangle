import { ANALYTICS } from '../src/config.js';

/**
 * The three numbers, off PostHog's query API and into one variable.
 *
 * This is the same bargain the pool client makes, for the same reason: nothing that reads
 * these may be made to wait on PostHog. `/api/stats` answers off the object below on the
 * frame it is asked, and a refresh in the background is what keeps that object honest — so
 * a slow query, a rate limit or an outage costs a stale number rather than a hung request.
 *
 * Every failure mode is therefore the same failure mode: whatever was last known stays.
 * There is no state in which a reachable PostHog and an unreachable one produce different
 * *shapes* here, only different `fetchedAt`.
 */

/**
 * The variable. Read it directly, or over `/api/stats`.
 *
 * `null` is "never successfully fetched", and it is not the same as `0` — a project with no
 * traffic yet reports zero visitors, and a project whose key is wrong reports nothing at
 * all. Collapsing the two would put a confident `0` on the screen for a misconfiguration,
 * which is the one number a broken integration must never produce.
 *
 * Mutated in place rather than reassigned, so that `import { stats }` anywhere else keeps
 * pointing at the live object instead of at whatever it held on first import.
 */
export const stats = {
  /** Unique people who have ever loaded the game, all time. */
  totalVisitors: null,
  /** Unique people seen in the last ANALYTICS.LIVE_WINDOW_MINUTES. */
  currentVisitors: null,
  /** Mean session length in seconds over ANALYTICS.SESSION_WINDOW_DAYS. */
  avgSessionSeconds: null,
  /** When the last *successful* refresh landed, ms since epoch. 0 if there has never been one. */
  fetchedAt: 0,
};

/**
 * One query per number, rather than one query for all three.
 *
 * They could be a single SELECT with three scalar subqueries, and that would cost a third of
 * the rate limit. It would also fail as one: `sessions` and `events` are different tables
 * with different retention, and a project whose session data is not populated yet would
 * take the visitor counts down with it. Three queries fail three ways, and `refresh()` keeps
 * whichever ones answered — which on a fresh project is exactly the difference between two
 * working numbers and none.
 *
 * The windows are interpolated because HogQL has no bind parameters for INTERVAL. They are
 * rounded integers from config rather than anything a request can reach, and the rounding is
 * the guard: it is what makes the interpolation unable to carry a string, not a convention
 * that the next person to add a knob here has to know about.
 */
const LIVE_MINUTES = Math.max(1, Math.round(ANALYTICS.LIVE_WINDOW_MINUTES));
const SESSION_DAYS = Math.max(1, Math.round(ANALYTICS.SESSION_WINDOW_DAYS));

export const QUERIES = {
  // Counted off $pageview rather than off every event, so that a future `posthog.capture`
  // of something the game does cannot change what "a visitor" means. uniq() is PostHog's
  // approximate distinct — the exact one scans the whole table and this is an all-time count.
  totalVisitors: "SELECT uniq(person_id) FROM events WHERE event = '$pageview'",

  currentVisitors:
    `SELECT uniq(person_id) FROM events WHERE timestamp >= now() - INTERVAL ${LIVE_MINUTES} MINUTE`,

  // $session_duration is seconds. avg() over no rows is null, not 0, which is why the
  // parser below treats null as "no answer" and leaves the previous value alone.
  avgSessionSeconds:
    `SELECT avg($session_duration) FROM sessions WHERE $start_timestamp >= now() - INTERVAL ${SESSION_DAYS} DAY`,
};

/**
 * The single scalar out of a query response, or null.
 *
 * PostHog answers `{ results: [[value]], columns: [...] }`. Everything about that shape is
 * re-checked rather than trusted: this is a parsed network response, and a string where a
 * number belongs would be served straight back out of `/api/stats` and formatted into a
 * NaN by whatever is showing it.
 */
function scalar(body) {
  const value = body?.results?.[0]?.[0];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // PostHog returns big counts as strings in some column types; take those, reject the rest.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/**
 * The stats reader.
 *
 * Constructed from the environment by `fromEnv()` below, or by hand in a test. `fetch` and
 * `now` are injectable for the same reason they are on the pool client: every interesting
 * case here is a failure case, and they are not reachable against the real API.
 */
export class PostHogStats {
  constructor({
    // The app host, not the ingest one — see ANALYTICS.DEFAULT_API_HOST.
    host = ANALYTICS.DEFAULT_API_HOST,
    projectId = '',
    apiKey = '',
    now = () => Date.now(),
    fetch: fetchImpl = globalThis.fetch,
  } = {}) {
    // Trailing slashes are how this ends up requesting `//api/projects` and 404ing against
    // a URL that looks correct in the error message.
    this.host = String(host).replace(/\/+$/, '');
    this.projectId = String(projectId);
    this.apiKey = String(apiKey);
    this.now = now;
    this.fetch = fetchImpl;
    this.timer = null;
  }

  /** Whether there is enough configuration to ask PostHog anything at all. */
  get configured() {
    return Boolean(this.host && this.projectId && this.apiKey);
  }

  get endpoint() {
    return `${this.host}/api/projects/${encodeURIComponent(this.projectId)}/query/`;
  }

  /** Runs one HogQL query and returns its single scalar. Throws; `refresh` is what catches. */
  async #query(hogql) {
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        // Bearer, not the `phc_` key — this endpoint only accepts a personal API key with
        // the "query read" scope, and answers 401 for a project key that looks fine.
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query: { kind: 'HogQLQuery', query: hogql } }),
      signal: AbortSignal.timeout?.(ANALYTICS.TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return scalar(await response.json());
  }

  /**
   * Brings all three numbers up to date, and never throws.
   *
   * Settled rather than awaited as a group: one query being rate-limited must not discard
   * the two that answered. A query that fails, or that answers null, leaves its number
   * exactly as it was — so the object degrades to "stale" and never to "wrong".
   *
   * `fetchedAt` moves only if something actually landed, which is what makes it usable as
   * the health signal it looks like.
   */
  async refresh() {
    if (!this.configured) return stats;

    const names = Object.keys(QUERIES);
    const settled = await Promise.allSettled(names.map((name) => this.#query(QUERIES[name])));

    let landed = false;
    settled.forEach((result, i) => {
      if (result.status !== 'fulfilled' || result.value === null) return;
      stats[names[i]] = result.value;
      landed = true;
    });
    if (landed) stats.fetchedAt = this.now();

    return stats;
  }

  /**
   * Refreshes now, and then every REFRESH_MS.
   *
   * The first refresh is deliberately not awaited by callers — `start()` in the server calls
   * this and carries on, because a PostHog that is slow to answer must not be a game that is
   * slow to serve. The interval is unref'd so it cannot be the reason the process outlives
   * its work, which is what would otherwise make `npm test` hang after the last assertion.
   */
  start() {
    if (!this.configured || this.timer) return this;

    this.refresh().catch(() => {});
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, ANALYTICS.REFRESH_MS);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

/**
 * The reader the server actually runs, built from the environment.
 *
 * Unset variables are not an error. The game is playable, deployable and testable without a
 * PostHog account, so an absent key makes this inert rather than fatal — `configured` is
 * false, `start()` does nothing, and `/api/stats` answers the nulls it was born with.
 */
export function fromEnv(env = process.env) {
  return new PostHogStats({
    host: env.POSTHOG_HOST || ANALYTICS.DEFAULT_API_HOST,
    projectId: env.POSTHOG_PROJECT_ID || '',
    apiKey: env.POSTHOG_PERSONAL_API_KEY || '',
  });
}
