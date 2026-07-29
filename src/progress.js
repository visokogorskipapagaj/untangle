/**
 * Persisted progress.
 *
 * Kept out of the HUD deliberately: the game model writes here, and having the model
 * import from a DOM module was the one backwards edge in the dependency graph.
 *
 * Everything loaded is treated as untrusted. A hand-edited or schema-drifted record
 * used to reach the game as, say, a string where an object belonged, and blow up on
 * first solve — a try/catch around the parse does nothing for that.
 */

import { CLOCK } from './config.js';

const STORAGE_KEY = 'untangle.progress.v2';

const DEFAULTS = () => ({
  maxStage: 1,
  total: 0,
  best: {},
  /**
   * Clear times in ms per stage, `{ "7": [18400, 16200, ...] }` — the whole input to the
   * stage clock, and the only input it has. A record written before the clock existed
   * simply has none, which is the same state as a new player's and needs no migration:
   * every stage is untimed until it has been cleared once, and that is true whether the
   * record is empty or absent.
   */
  times: {},
  /**
   * Briefings this record has already been shown, `{ clock: true }` — see BRIEFING in
   * config.js. Each one is a panel that opens on the stage its mechanic arrives and never
   * again, so this is the whole of "again". Absent on any record written before they
   * existed, which is the same state as a new player's and needs no migration.
   */
  briefed: {},
  options: { distinct: false, markers: true },
});

const finite = (value, fallback, min = 0) =>
  typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function loadProgress() {
  const progress = DEFAULTS();

  let parsed;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return progress;
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt JSON, or storage unavailable (private mode, quota). Start fresh rather
    // than blocking the game on it.
    return progress;
  }

  if (!isPlainObject(parsed)) return progress;

  progress.maxStage = Math.floor(finite(parsed.maxStage, 1, 1));
  progress.total = finite(parsed.total, 0);

  if (isPlainObject(parsed.best)) {
    for (const [stage, score] of Object.entries(parsed.best)) {
      if (/^\d+$/.test(stage) && typeof score === 'number' && Number.isFinite(score)) {
        progress.best[stage] = score;
      }
    }
  }

  // Every sample is checked and the list is cut to length here rather than trusted and
  // cleaned up downstream: the clock reads this on every stage load, and one hand-edited
  // record with a hundred thousand entries would be felt as a stutter between stages.
  if (isPlainObject(parsed.times)) {
    for (const [stage, samples] of Object.entries(parsed.times)) {
      if (!/^\d+$/.test(stage) || !Array.isArray(samples)) continue;
      const clean = samples
        // `{ ms }` is how these were written while the deadline still cared about board
        // size. The time is the only part that was ever used to set a deadline, so the
        // records are worth keeping rather than resetting every stage to untimed.
        .map((s) => (isPlainObject(s) ? s.ms : s))
        .filter((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0)
        .slice(-CLOCK.KEEP);
      if (clean.length) progress.times[stage] = clean;
    }
  }

  // Only ever `true` is copied across, and only for keys that look like card names. A
  // hand-edited record cannot use this to hide a briefing behind a truthy string, and it
  // cannot grow: an unknown key is simply a briefing that does not exist.
  if (isPlainObject(parsed.briefed)) {
    for (const [key, seen] of Object.entries(parsed.briefed)) {
      if (/^[a-z][a-z0-9]*$/.test(key) && seen === true) progress.briefed[key] = true;
    }
  }

  if (isPlainObject(parsed.options)) {
    progress.options.distinct = parsed.options.distinct === true;
    progress.options.markers = parsed.options.markers !== false;
  }

  return progress;
}

export function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // Nothing to do — progress is a nicety, not a requirement.
  }
}
