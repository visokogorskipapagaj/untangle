import { CLOCK } from './config.js';

/**
 * The stage clock, and the model that decides how long it runs for.
 *
 * Nothing here estimates how long a board *should* take. The only input is a list of times
 * the player actually finished this stage in, so a stage with no record has no deadline —
 * the first clear of every stage is untimed, and the clock is doing nothing but measuring.
 * Every attempt after that is measured against their own past runs.
 *
 * The whole model is three steps:
 *
 *   trim     throw the extreme runs off both ends, so one interrupted run and one freak
 *            fast one cannot move the number.
 *   strike   past par, remove the slowest surviving runs — one more per stage — so the
 *            average being aimed at slides from "a typical run" toward "your best run".
 *   slack    multiply by the margin for the stage: SLACK_START early, nothing at par.
 *
 * There is deliberately no floor, no prior and no notion of board size. Every deadline is
 * the mean of runs this player really completed, so the tightest one reachable is a time
 * they have already proved they can hit. A model built only from measurements cannot
 * describe an impossible stage, which is exactly why it does not need protecting from one.
 *
 * Everything except StageClock is pure, and `history` is read-only outside recordClear.
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
 * How long this attempt gets, in ms, or null for no limit.
 *
 * Null is not a failure case — it is the first clear of every stage, and the reason a
 * countdown can sit on a puzzle at all without ever timing the player out of one they
 * have never seen.
 */
export function stageDeadline(stage, history = {}) {
  const expected = expectedTime(stage, history);
  return expected === null ? null : expected * slackFor(stage);
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
 */
export function recordClear(history, stage, ms) {
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
  // used to be.
  if (samples.length > CLOCK.KEEP) samples.splice(0, samples.length - CLOCK.KEEP);
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
