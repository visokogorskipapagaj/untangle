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

const STORAGE_KEY = 'untangle.progress.v2';

const DEFAULTS = () => ({
  maxStage: 1,
  total: 0,
  best: {},
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
