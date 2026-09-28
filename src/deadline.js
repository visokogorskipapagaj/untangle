import { CLOCK } from './config.js';

/**
 * The stage clock, and the model that decides how long it runs for.
 *
 * Nothing here estimates how long a board *should* take. The only input is times somebody
 * really finished this stage in: the shared pool's when it has any, and the times on this
 * device when it does not. A stage nobody has ever cleared still has no deadline.
 *
 * One fact shapes everything below. Only clears are filed, and a clear is by definition
 * faster than the deadline it was played against. So a stage's record is not "how long the
 * stage takes"; it is "how long it took the people who made it", which is always the fast
 * end. A model that averages that record and hands the average back as the next deadline
 * can only walk downward, because every new sample lands under the number it produced. The
 * previous model did exactly that, with a margin that reached 1.0 at par, and simulated
 * against a population of players it left a median player clearing stage 10 one time in
 * ten and nothing at all past par.
 *
 * The quote is built to hold still under that bias:
 *
 *   trim     throw the extreme runs off both ends, so one interrupted run and one freak
 *            fast one cannot move the number.
 *   target   read the *slow* end of what survives (a quantile, not the mean): the slow end
 *            of the clears is the closest thing on record to what the stage takes. Past par
 *            the quantile eases down toward the median, which is the whole of the late
 *            game. The target moves from "a slow clear" to "a typical one" and stops there.
 *            It never chases the fastest run.
 *   thin     a record of one or two runs is quoted wide, tapering off as runs arrive. One
 *            expert's debut clear is not a par.
 *   slack    multiply by the stage's margin: SLACK_START early, SLACK_END at par and after.
 *            SLACK_END sits above 1 on purpose. A margin of exactly 1 is the ratchet.
 *   floor    never under FLOOR_MS. Below that a deadline is a reflex test, not a clock.
 *
 * The pool and the device run the identical quote. When both answer, the looser one wins:
 * nobody is held to a tighter standard than their own record shows they meet, and nobody
 * is held to their own record when the playerbase is slower than they are.
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

const clamp01 = (t) => Math.min(1, Math.max(0, t));

/**
 * Drops the fastest and slowest `trim` of an already-sorted list.
 *
 * Rounding down is what makes this safe on small sets: below 1/TRIM samples nothing is
 * dropped, which is correct. Until there are enough clears to show a shape there is no way
 * to tell a spike from the trend. The fallback only matters if TRIM is ever tuned past 0.5,
 * and is there so that tuning it cannot silently start returning NaN.
 */
function trimEnds(sorted, trim = CLOCK.TRIM) {
  const drop = Math.floor(sorted.length * trim);
  const kept = sorted.slice(drop, sorted.length - drop);
  return kept.length ? kept : sorted;
}

/** Mean of a set of times with the extremes discarded. What recordClear clamps against. */
export function trimmedMean(values, trim = CLOCK.TRIM) {
  if (!values.length) return 0;
  return mean(trimEnds([...values].sort((a, b) => a - b), trim));
}

/**
 * Linear-interpolated quantile of a sorted list. One sample is its own every quantile.
 */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = clamp01(q) * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(sorted.length - 1, lo + 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * The margin a stage is given on top of its quoted time: SLACK_START at stage 1, falling
 * linearly to SLACK_END at PAR_STAGE and holding there.
 *
 * It never reaches 1.0, and that is the point rather than a tuning. The record is clears
 * only, every clear sits under the deadline that produced it, and a deadline of exactly
 * "the record" can therefore only fall. SLACK_END is the resting margin that lets slower
 * clears back into the record so the quote has somewhere to settle.
 */
export function slackFor(stage) {
  if (stage >= CLOCK.PAR_STAGE) return CLOCK.SLACK_END;
  const t = (stage - 1) / Math.max(1, CLOCK.PAR_STAGE - 1);
  return CLOCK.SLACK_START + (CLOCK.SLACK_END - CLOCK.SLACK_START) * t;
}

/**
 * Which point of the record a stage is quoted at.
 *
 * TARGET up to par, then easing down to TARGET_END over the TIGHTEN_STAGES after it, and
 * flat from there. This is the entire late-game difficulty curve: the quote slides from a
 * slow clear toward a typical one. It stops at the median rather than walking on toward
 * the fastest run, because the fastest run on a pooled record is somebody else's best day.
 */
export function targetFor(stage) {
  const t = clamp01((stage - CLOCK.PAR_STAGE) / Math.max(1, CLOCK.TIGHTEN_STAGES));
  return CLOCK.TARGET + (CLOCK.TARGET_END - CLOCK.TARGET) * t;
}

/**
 * How much wider a quote is read when there are few runs behind it: 1 + THIN_MARGIN with
 * nothing on record, tapering to exactly 1 at CONFIDENT_N runs.
 *
 * Below 1/TRIM samples the trim cannot reject anything, so a record that thin is one or two
 * people's runs taken at face value. Quoting it wide is what stops the first expert
 * through a stage from setting its par for everyone after them.
 */
export function thinFor(count) {
  return 1 + CLOCK.THIN_MARGIN * Math.max(0, 1 - count / CLOCK.CONFIDENT_N);
}

/**
 * The runs a stage's quote is read from: fastest first, extremes trimmed.
 *
 * Exported because it is the honest answer to "where did that number come from". The debug
 * readout shows how many runs survived, and it is what the tests assert against. Works over
 * the device's history and over the pool alike; both are stage -> times.
 */
export function runsCounted(stage, record) {
  return trimEnds(samplesFor(record, stage));
}

/**
 * What a record says this stage takes, before the margin is applied, or null with nothing
 * on record. Trim, target, thin: the same three steps whichever population `record` is.
 */
export function quotedTime(stage, record) {
  const runs = runsCounted(stage, record);
  if (!runs.length) return null;
  return quantile(runs, targetFor(stage)) * thinFor(runs.length);
}

/** What this player typically needs for this stage, before the margin is applied. */
export function expectedTime(stage, history) {
  return quotedTime(stage, history);
}

/**
 * What the playerbase typically needs for this stage, before the margin is applied.
 *
 * This runs on the server, over the raw pool, and its answer is what ships to the client as
 * that stage's par. The alternative, sending the samples and letting every client do this,
 * is a couple of hundred kilobytes of numbers to compute one, and the quote depends only on
 * the stage, so there is nothing per-player to wait for.
 */
export function pooledTime(stage, pool) {
  return quotedTime(stage, pool);
}

/** A stage's par out of the table the server sends, or null if it has none. */
function parFor(pars, stage) {
  const ms = pars?.[String(stage)];
  return typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * How long this attempt gets, in ms, or null for no limit.
 *
 * `pars` is the server's table, stage -> quoted ms, already trimmed, targeted and widened
 * by pooledTime. The device's own history is quoted the same way. When only one answers it
 * decides; when both do, the looser one does (CLOCK.OWN_FLOOR). Both are real measurements,
 * so neither is a fallback in the sense of being worse: they are the same model over
 * different populations, and a player is never asked for more than either says.
 *
 * Null is not a failure case. It is a stage nobody has ever cleared, and it is the reason a
 * countdown can sit on a genuinely new puzzle without timing anyone out of it.
 */
export function stageDeadline(stage, history = {}, pars = {}) {
  const own = expectedTime(stage, history);
  const pooled = CLOCK.UNTIMED_FIRST_CLEAR && own === null ? null : parFor(pars, stage);
  if (own === null && pooled === null) return null;

  let expected;
  if (pooled === null) expected = own;
  else if (own === null || !CLOCK.OWN_FLOOR) expected = pooled;
  else expected = Math.max(pooled, own);

  return Math.max(CLOCK.FLOOR_MS, expected * slackFor(stage));
}

/**
 * Files a completed stage.
 *
 * Clamped against the stage's own typical time before it goes in: with the trim unable to
 * do anything until there are ten samples, one absurd run would otherwise set the deadline
 * for the next several attempts on its own. OUTLIER is wide enough that no amount of real
 * improvement or real struggle is touched by it. It is there for the run that was left
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
 *
 * `typical` lets the caller judge against a figure taken before a batch was filed. The
 * clamp is relative, so fifty entries filed one after another each pull the figure the
 * next one is judged against a little lower; judged against the same snapshot they cannot.
 */
export function recordClear(history, stage, ms, keep = CLOCK.KEEP, typical = null) {
  const key = String(stage);
  const samples = history[key] || (history[key] = []);

  let time = Math.max(1, Math.round(ms));
  const against = typical ?? (samples.length ? trimmedMean(samples) : null);
  if (against) {
    const low = against / CLOCK.OUTLIER;
    const high = against * CLOCK.OUTLIER;
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
 * the one whose duration most needs measuring: that measurement is what times it next
 * time. Ticking is the caller's decision: the game holds it still behind an open dialog.
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
 * blanking: the clock is off, not missing.
 *
 * `tenths` is what makes this a countdown, so a readout reporting a finished duration
 * turns it off: the urgency is the only reason for the decimal, and there is none left
 * once the stage is over.
 *
 * Both scales round *up*, and that is the whole of what makes "0.0" trustworthy. Rounding
 * to nearest would put 0.0 on screen with up to 50ms still on the clock, a stage the
 * player can still act on, reading as one that is already over. Ceiling means every
 * displayed value is time the player really has, and 0.0 appears at zero and nowhere else.
 */
export function formatClock(ms, { tenths = true } = {}) {
  if (!Number.isFinite(ms)) return '∞';
  const left = Math.max(0, ms);
  if (tenths && ms < CLOCK.CRITICAL_MS) return (Math.ceil(left / 100) / 10).toFixed(1);
  const whole = Math.ceil(left / 1000);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}
