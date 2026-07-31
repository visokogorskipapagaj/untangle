import { ANALYTICS, POOL } from './config.js';

/**
 * The browser's half of PostHog: the capture side, and a local copy of the three numbers.
 *
 * The key here is the project API key — `phc_...`, write-only, public by design — and Vite
 * inlines it into the bundle at build time from `VITE_POSTHOG_KEY`. That is the intended
 * handling for this particular key and only for this one: the personal key that reads the
 * project must never be named `VITE_*`, because everything under that prefix ends up in
 * `dist/` and therefore on every player's machine. See server/stats.js for that half.
 *
 * With no key configured this module is inert. The game runs identically without PostHog,
 * which is what makes `npm run dev` on a fresh checkout work without an account.
 */

// `||` rather than `??`, and that is load-bearing. An unset variable is undefined, but a
// build arg declared and not passed — which is what the Dockerfile does on a PR build —
// inlines an empty string, and `??` would take it as a value: `api_host: ''`. Both spellings
// of "not configured" have to reach the same place.
const KEY = import.meta.env.VITE_POSTHOG_KEY || '';
// The ingest host, not the app one. This half only ever writes events.
const HOST = import.meta.env.VITE_POSTHOG_HOST || ANALYTICS.DEFAULT_INGEST_HOST;

/** Whether a key was compiled in. False on a checkout with no `.env`, and that is fine. */
export const analyticsEnabled = Boolean(KEY);

/**
 * Starts capturing, once.
 *
 * Imported dynamically, and that is a size decision rather than a style one: posthog-js is
 * 229kB — call it three times the entire rest of the game — and a static import puts all of
 * it on the boot path of a canvas game whose own bundle is 83kB. As a dynamic import it is
 * a chunk of its own: the guard above returns before the import, so a build with no key
 * configured (a fresh checkout, a PR build) never requests it, and a build with one loads
 * the game first and PostHog alongside. The chunk is still emitted either way — it is the
 * fetch that is conditional, not the file. Main bundle: 83kB, with or without.
 *
 * The cost is that the pageview is captured a round trip later than it could be, so a
 * player who closes the tab inside that window is not counted. That is the right side of
 * the trade: the alternative is every player waiting on the analytics before the title
 * screen, which would show up in the very session-length numbers this exists to report.
 *
 * Autocapture and pageviews are left on, because they are what the three numbers are
 * counted off: `totalVisitors` and `currentVisitors` are both derived from `$pageview`, and
 * turning it off here would empty out the stats without anything failing. Session recording
 * is off — this is a canvas game, so a replay is a video of a blank rectangle, and it is
 * the one default that costs the player bandwidth for nothing.
 *
 * Never throws. A blocked or failed chunk is a game that runs without analytics, which is
 * the same state a fresh checkout is in.
 */
export async function startAnalytics(): Promise<void> {
  if (!analyticsEnabled) return;

  let posthog;
  try {
    ({ default: posthog } = await import('posthog-js'));
  } catch {
    // An ad blocker, an offline load, a chunk that 404s past a bad deploy. None of them
    // are the game's problem, and none of them should reach the player as one.
    return;
  }

  posthog.init(KEY, {
    api_host: HOST,
    // The board is one canvas, so there is no DOM for a replay to record and no rage-click
    // to detect on it. Both cost the player bytes and buy nothing back.
    disable_session_recording: true,
    // Explicit because the stats depend on it, not because it differs from the default:
    // `$pageview` is what both visitor counts are counted off, so this is load-bearing
    // configuration rather than a preference.
    capture_pageview: true,
    // `person_profiles` is deliberately left at the library default. Nobody signs in to
    // this game, so there is nothing to identify and profiles for every anonymous player
    // would move the project into a more expensive billing tier to describe the same
    // people. `person_id` is populated for anonymous events regardless, which is what the
    // visitor queries count and what PostHog's own web analytics counts.
  });
}

export interface SiteStats {
  /** Unique people who have ever loaded the game. `null` until the server answers. */
  totalVisitors: number | null;
  /** Unique people seen in the last few minutes. */
  currentVisitors: number | null;
  /** Mean session length, in seconds. */
  avgSessionSeconds: number | null;
  /** When the server last heard from PostHog, ms since epoch. 0 if it never has. */
  fetchedAt: number;
  /** Whether these are real numbers or the nulls the server starts with. */
  live: boolean;
}

/**
 * The variable, browser side.
 *
 * Mutated in place and never reassigned, exactly like the pool's `pars` and for the same
 * reason: anything that imported it holds the live object rather than a snapshot taken at
 * module-evaluation time, so a reader can be written synchronously and still be right.
 *
 * Read it from anywhere — `siteStats.currentVisitors` — or off `globalThis.__stats` in the
 * console. It stays all-null until `refreshSiteStats()` lands, so every reader has to cope
 * with null anyway; there is no moment at which it is guaranteed populated.
 */
export const siteStats: SiteStats = {
  totalVisitors: null,
  currentVisitors: null,
  avgSessionSeconds: null,
  fetchedAt: 0,
  live: false,
};

/** Only the numeric fields, so the parse below cannot invent a key that isn't in the shape. */
const NUMERIC = ['totalVisitors', 'currentVisitors', 'avgSessionSeconds', 'fetchedAt'] as const;

/**
 * Fetches `/api/stats` into `siteStats`, and never throws.
 *
 * Same contract as `Pool.sync()`: not awaited by anything on the boot path, and a failure
 * leaves the previous values alone rather than clearing them. A dead server, a captive
 * portal and a project with no traffic are all indistinguishable from here, and all three
 * leave the game playing exactly as it does without any of this.
 *
 * Values are re-checked on the way in because this is a network response — a string where a
 * number belongs would reach whatever formats it and render as NaN.
 */
export async function refreshSiteStats(baseUrl = POOL.BASE_URL): Promise<SiteStats> {
  try {
    const response = await fetch(`${baseUrl}/api/stats`, {
      signal: AbortSignal.timeout?.(POOL.TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();

    for (const key of NUMERIC) {
      const value = body?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) siteStats[key] = value;
    }
    siteStats.live = Boolean(body?.live);
  } catch {
    // Keep whatever is there. These are numbers to show, not numbers to play by.
  }
  return siteStats;
}
