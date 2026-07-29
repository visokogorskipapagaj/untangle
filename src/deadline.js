import { CLOCK } from './config.js';

/**
 * The stage clock, and the model that decides how long it runs for.
 *
 * Nothing here estimates how long a board *should* take. The only input is times somebody
 * really finished this stage in — the shared pool's when it has any, and failing that the
 * times on this device. A stage nobody has ever cleared still has no deadline.
 *
 * The whole model is three steps, and they are the same three whichever source answers:
 *
 *   trim     throw the extreme runs off both ends, so one interrupted run and one freak
 *            fast one cannot move the number.
 *   strike   past par, aim at a smaller and smaller slice of the fastest surviving runs,
 *            so the average slides from "a typical run" toward "a very good one".
 *   slack    multiply by the margin for the stage: SLACK_START early, nothing at par.
 *
 * The strike step is expressed two ways for one reason. Against a personal history it is a
 * count — one more run struck per stage past par — which is a real 1/KEEP tightening on a
 * twenty-sample window. Against a pool of hundreds that same count would be noise, so the
 * pooled path uses the fraction that count *means* (see poolFraction) and gets an identical
 * curve at any sample size. Change one and you must change the other.
 *
 * What the pool cost us: the model used to need no floor, because every deadline was the
 * mean of runs this player really completed and the tightest one reachable was therefore a
 * time they had already proved they could hit. A model built only from your own
 * measurements cannot describe a stage you personally cannot clear. A pooled one can, and
 * for everybody below the playerbase's middle it routinely will. CLOCK.OWN_FLOOR puts that
 * invariant back deliberately instead of getting it for free.
 *
 * Everything except StageClock is pure. `history` and `pool` are read-only outside
 * recordClear, which only ever touches the former.
 */

/** A stage's recorded times, fastest first. Sorting is what every step below assumes. */
function samplesFor(history, stage) {
  const samples = history[String(stage)];
  return samples && samples.length ? [...samples].sort((a, b) => a - b) : [];
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Drops the fastest and slowest `trim` of an already-sorted list.
 *
 * Rounding down is what makes this safe on small sets: below 1/TRIM samples nothing is
 * dropped, which is correct — until there are enough clears to show a shape there is no
 * way to tell a spike from the trend. The fallback only matters if TRIM is ever tuned past
 * 0.5, and is there so that tuning it cannot silently start returning NaN.
 */
function trimEnds(sorted, trim = CLOCK.TRIM) {
  const drop = Math.floor(sorted.length * trim);
  const kept = sorted.slice(drop, sorted.length - drop);
  return kept.length ? kept : sorted;
}

/** Mean of a set of times with the extremes discarded. */
export function trimmedMean(values, trim = CLOCK.TRIM) {
  if (!values.length) return 0;
  return mean(trimEnds([...values].sort((a, b) => a - b), trim));
}

/**
 * The margin over the player's own average that a stage is given: SLACK_START at stage 1,
 * falling linearly to exactly 1.0 at PAR_STAGE and staying there.
 *
 * It never goes below 1.0. Asking for less than an average run is not expressed as a
 * smaller multiplier — a multiplier has no idea whether the number it is shrinking is
 * still achievable — it is expressed by tightening which runs the average is taken over.
 * See slowestStruck.
 */
export function slackFor(stage) {
  if (stage >= CLOCK.PAR_STAGE) return 1;
  const t = (stage - 1) / Math.max(1, CLOCK.PAR_STAGE - 1);
  return CLOCK.SLACK_START + (1 - CLOCK.SLACK_START) * t;
}

/**
 * How many of the slowest surviving runs are struck off the average before it is taken.
 *
 * Zero up to par, then one more per stage. This is the entire late-game difficulty curve:
 * the target stops being "a run like your usual ones" and becomes "a run like your better
 * ones", and finally "your best one". It runs out of runs to strike rather than running
 * into a limit, and the last one standing is a time already on the record.
 */
export function slowestStruck(stage) {
  return Math.max(0, stage - CLOCK.PAR_STAGE);
}

/**
 * The same curve as slowestStruck, as a fraction of the runs available.
 *
 * Striking one run per stage off a personal history means something because the history is
 * CLOCK.KEEP long: at stage PAR+5 it is aiming at the fastest 15 of 20, three quarters. Off
 * a pool of five hundred the identical rule would strike five and aim at 99% of them, and
 * the entire late game would quietly stop existing. So the pooled path asks what fraction
 * the count *represents* on a full personal window and applies that instead — same shape,
 * same endpoint, independent of how many runs happen to be in the sample.
 *
 * The floor of one KEEP-th is where the personal model ends too: the last run standing.
 * Past that stage the target stops tightening for both.
 */
export function poolFraction(stage) {
  const struck = slowestStruck(stage);
  return Math.max(1 / CLOCK.KEEP, 1 - struck / CLOCK.KEEP);
}

/**
 * The runs a stage's deadline is actually averaged over, fastest first.
 *
 * Exported because it is the honest answer to "where did that number come from" — the
 * debug readout shows how many runs survived, and it is what the tests assert against.
 */
export function runsCounted(stage, history) {
  const trimmed = trimEnds(samplesFor(history, stage));
  if (!trimmed.length) return [];
  // Never strike the last one: the fastest surviving run is the floor, and it is a real
  // time rather than a number anybody chose.
  const keep = Math.max(1, trimmed.length - slowestStruck(stage));
  return trimmed.slice(0, keep);
}

/** What this player typically needs for this stage, before the margin is applied. */
export function expectedTime(stage, history) {
  const runs = runsCounted(stage, history);
  return runs.length ? mean(runs) : null;
}

/**
 * The pool's runs for a stage, fastest first, after trim and the late-game slice.
 *
 * Exported for the same reason runsCounted is: it is the honest answer to where a pooled
 * number came from, and it is what the tests assert against.
 */
export function pooledRuns(stage, pool) {
  const trimmed = trimEnds(samplesFor(pool, stage));
  if (!trimmed.length) return [];
  // Ceiling, not floor: a two-sample pool at the tightest stage should aim at its faster
  // run, not at nothing. Never below one for the same reason runsCounted never strikes
  // its last survivor.
  const keep = Math.max(1, Math.ceil(trimmed.length * poolFraction(stage)));
  return trimmed.slice(0, keep);
}

/**
 * What the playerbase typically needs for this stage, before the margin is applied.
 *
 * This runs on the server, over the raw pool, and its answer is what ships to the client
 * as that stage's par. The alternative — sending the samples and letting every client do
 * this — is a couple of hundred kilobytes of numbers to compute one, and the slice depends
 * only on the stage, so there is nothing per-player to wait for.
 */
export function pooledTime(stage, pool) {
  const runs = pooledRuns(stage, pool);
  return runs.length ? mean(runs) : null;
}

/** A stage's par out of the table the server sends, or null if it has none. */
function parFor(pars, stage) {
  const ms = pars?.[String(stage)];
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * How long this attempt gets, in ms, or null for no limit.
 *
 * `pars` is the server's table, stage -> expected ms, already trimmed and sliced by
 * pooledTime. It answers when it has anything to say; the device's own history is what is
 * left when it does not, which covers a dead server, a first load offline, and a stage
 * further out than anyone has reached. Both are real measurements, so neither is a
 * fallback in the sense of being worse — they are the same model over different
 * populations.
 *
 * Null is not a failure case. It is a stage nobody has ever cleared, and it is the reason
 * a countdown can sit on a genuinely new puzzle without timing anyone out of it.
 */
export function stageDeadline(stage, history = {}, pars = {}) {
  const own = expectedTime(stage, history);
  const pooled = CLOCK.UNTIMED_FIRST_CLEAR && own === null ? null : parFor(pars, stage);

  const expected = pooled ?? own;
  if (expected === null) return null;

  const deadline = expected * slackFor(stage);
  if (!CLOCK.OWN_FLOOR || pooled === null) return deadline;

  // samplesFor sorts fastest first, so [0] is the best this player has ever done on this
  // stage. A pooled deadline is allowed to be anything down to that and no tighter: they
  // have already proved that time once. Nothing to do if they never have — which is the
  // case the floor cannot rescue, and the price of a pooled model.
  const best = samplesFor(history, stage)[0];
  return best ? Math.max(deadline, best) : deadline;
}

/**
 * Files a completed stage.
 *
 * Clamped against the stage's own typical time before it goes in: with the trim unable to
 * do anything until there are ten samples, one absurd run would otherwise set the deadline
 * for the next several attempts on its own. OUTLIER is wide enough that no amount of real
 * improvement or real struggle is touched by it — it is there for the run that was left
 * sitting on screen, not for the slow one. The first ever clear has nothing to be judged
 * against and is taken as it stands.
 *
 * Mutates `history` in place and returns the time that was stored.
 *
 * `keep` is a parameter because the server files into the shared pool with exactly this
 * function and a much longer window (POOL.SERVER_KEEP). The clamp is the reason to share
 * it rather than write a second copy: it is the only thing standing between the pool and
 * one forged submission, and a divergent second implementation of it is precisely the bug
 * nobody would notice until the pool was already poisoned.
 */
export function recordClear(history, stage, ms, keep = CLOCK.KEEP) {
  const key = String(stage);
  const samples = history[key] || (history[key] = []);

  let time = Math.max(1, Math.round(ms));
  if (samples.length) {
    const typical = trimmedMean(samples);
    const low = typical / CLOCK.OUTLIER;
    const high = typical * CLOCK.OUTLIER;
    time = Math.round(Math.min(Math.max(time, low), high));
  }

  samples.push(time);
  // Oldest out first: the window follows the player rather than averaging in who they
  // used to be. On the server it follows the playerbase for the same reason.
  if (samples.length > keep) samples.splice(0, samples.length - keep);
  return time;
}

/**
 * The running clock for one attempt.
 *
 * `elapsed` accrues whether or not there is a limit, because an untimed stage is exactly
 * the one whose duration most needs measuring — that measurement is what times it next
 * time. Ticking is the caller's decision: the game holds it still behind an open dialog,
 * and does not start it until the countdown hands the board over.
 */
export class StageClock {
  constructor() {
    this.limit = null;
    this.elapsed = 0;
  }

  begin(limit = null) {
    this.limit = limit;
    this.elapsed = 0;
  }

  tick(dt) {
    this.elapsed += dt;
  }

  get timed() {
    return this.limit !== null;
  }

  get remaining() {
    return this.timed ? Math.max(0, this.limit - this.elapsed) : Infinity;
  }

  get expired() {
    return this.timed && this.elapsed >= this.limit;
  }

  /** 1 at the start, 0 at the buzzer. Pinned at 1 while untimed, so meters sit full. */
  get fraction() {
    return this.timed && this.limit > 0 ? this.remaining / this.limit : 1;
  }
}

/**
 * Clock readout. Minutes and seconds, dropping to tenths inside the last CRITICAL_MS.
 *
 * The switch to a decimal is the readout admitting the situation has changed: a number
 * ticking once a second and a number blurring through tenths are read differently at a
 * glance, and by the time it matters the player has no attention spare for reading
 * carefully. Infinity is the untimed stage, which is a state worth naming rather than
 * blanking — the clock is off, not missing.
 *
 * `tenths` is what makes this a countdown, so a readout reporting a finished duration
 * turns it off: the urgency is the only reason for the decimal, and there is none left
 * once the stage is over.
 */
export function formatClock(ms, { tenths = true } = {}) {
  if (!Number.isFinite(ms)) return '∞';
  const seconds = Math.max(0, ms) / 1000;
  if (tenths && ms < CLOCK.CRITICAL_MS) return seconds.toFixed(1);
  const whole = Math.ceil(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
