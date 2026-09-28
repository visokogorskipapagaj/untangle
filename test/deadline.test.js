import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOCK } from '../src/config.js';
import {
  expectedTime,
  formatClock,
  pooledTime,
  quantile,
  quotedTime,
  recordClear,
  runsCounted,
  slackFor,
  StageClock,
  stageDeadline,
  targetFor,
  thinFor,
  trimmedMean,
} from '../src/deadline.js';

/** The stage clock: what it reads out of a record of clear times, and nothing else. */

/** A history where `stage` was cleared in each of `times`, in ms. */
const history = (stage, times) => ({ [String(stage)]: [...times] });

/** n runs spread evenly from `from` to `to` ms, in a deliberately jumbled order. */
function spread(from, to, n) {
  const step = (to - from) / Math.max(1, n - 1);
  const runs = Array.from({ length: n }, (_, i) => Math.round(from + i * step));
  return runs.filter((_, i) => i % 2 === 0).concat(runs.filter((_, i) => i % 2 === 1));
}

/** Enough identical runs that neither the trim nor the thin margin has anything to do. */
const settled = (ms) => Array(CLOCK.CONFIDENT_N + 2).fill(ms);

// --- the average -------------------------------------------------------------------

test('trimmed mean throws away the extremes once there are enough to throw away', () => {
  // Ten samples: 10% off each end drops exactly one from each. The 1 and the 1000 are the
  // spikes the trim exists for; without them the mean is 5, with them it is over 100.
  assert.equal(
    trimmedMean([1, 3, 4, 5, 5, 5, 6, 7, 8, 1000]),
    (3 + 4 + 5 + 5 + 5 + 6 + 7 + 8) / 8,
  );
});

test('below ten samples nothing is trimmed', () => {
  // 10% of 9 floors to 0. Intended, not an edge case: until there are enough clears to
  // show a shape there is no way to tell a spike from the trend.
  assert.equal(trimmedMean([1, 2, 3, 4, 5, 6, 7, 8, 900]), 936 / 9);
  assert.equal(trimmedMean([5]), 5);
  assert.equal(trimmedMean([]), 0);
});

test('the trim is order-independent', () => {
  const values = [1000, 5, 3, 8, 5, 4, 6, 1, 7, 5];
  assert.equal(trimmedMean(values), trimmedMean([...values].reverse()));
});

test('a trim that would drop everything falls back to the whole set', () => {
  assert.equal(trimmedMean([10, 20], 0.5), 15);
});

test('the quantile interpolates, and one sample is every quantile of itself', () => {
  assert.equal(quantile([10, 20, 30, 40, 50], 0.5), 30);
  assert.equal(quantile([10, 20, 30, 40, 50], 0.75), 40);
  assert.equal(quantile([10, 20], 0.75), 17.5, 'between two samples, by position');
  assert.equal(quantile([42], 0.1), 42);
  assert.equal(quantile([42], 0.9), 42);
  assert.equal(quantile([], 0.5), null);
});

// --- no data, no deadline ----------------------------------------------------------

test('a stage that has never been cleared is untimed', () => {
  assert.equal(stageDeadline(1, {}), null);
  assert.equal(stageDeadline(7, history(3, [20000])), null);
  assert.equal(expectedTime(1, {}), null);
  assert.deepEqual(runsCounted(1, {}), []);
});

test('the first clear of a stage is what makes the next one timed', () => {
  const times = {};
  assert.equal(stageDeadline(5, times), null, 'debut runs untimed');

  recordClear(times, 5, 30000);
  assert.ok(stageDeadline(5, times) > 0, 'and every attempt after it is timed');
});

test('clearing one stage puts no clock on any other', () => {
  // Each stage answers only for itself. Nothing is inferred across them.
  const times = {};
  recordClear(times, 4, 30000);
  assert.equal(stageDeadline(9, times), null);
  assert.equal(stageDeadline(3, times), null);
});

// --- the margin ----------------------------------------------------------------------

test('slack opens at SLACK_START and settles at SLACK_END from par on', () => {
  assert.equal(slackFor(1), CLOCK.SLACK_START);
  assert.equal(slackFor(1), 1.4, 'the stated 40% for the first stages');
  assert.ok(Math.abs(slackFor(CLOCK.PAR_STAGE) - CLOCK.SLACK_END) < 1e-9);
  assert.equal(slackFor(CLOCK.PAR_STAGE + 40), CLOCK.SLACK_END);
});

test('the margin never reaches 1.0, because a margin of 1.0 is a ratchet', () => {
  // The record is clears only, and a clear is always under the deadline it was played
  // against. Quote the record back at exactly 1.0 and every filed run lowers the next
  // deadline, which admits only faster runs, and so on down to the fastest clear anyone
  // ever had. SLACK_END above 1 is what gives the quote somewhere to settle.
  assert.ok(CLOCK.SLACK_END > 1, `SLACK_END is ${CLOCK.SLACK_END}`);

  let previous = Infinity;
  for (let stage = 1; stage <= 80; stage++) {
    const slack = slackFor(stage);
    assert.ok(slack <= previous + 1e-12, `slack must not rise at stage ${stage}`);
    assert.ok(slack >= CLOCK.SLACK_END - 1e-12, `slack fell under SLACK_END at stage ${stage}`);
    previous = slack;
  }
});

test('an early stage is handed its quote plus the margin', () => {
  // Enough identical runs that the quote is unambiguous, so the deadline is the margin.
  const times = history(1, settled(10000));
  assert.equal(expectedTime(1, times), 10000);
  assert.equal(stageDeadline(1, times), 14000, '10s on record, 40% on top');
});

test('at par the deadline is the quote plus the resting margin', () => {
  const times = history(CLOCK.PAR_STAGE, settled(10000));
  assert.equal(stageDeadline(CLOCK.PAR_STAGE, times), 10000 * CLOCK.SLACK_END);
});

// --- the target: the slow end of the record, easing to the middle past par -------------

test('the quote reads the slow end of the record, not its average', () => {
  // Twelve runs from 10s to 21s. The trim takes the 10s and the 21s off; the quote is the
  // 75th percentile of what survives, which is well above the mean. The average of the
  // clears is biased fast by construction, since the slow attempts never got filed.
  const runs = spread(10000, 21000, 12);
  const counted = runsCounted(5, history(5, runs));
  assert.equal(counted.length, 10, 'one off each end');

  const quote = expectedTime(5, history(5, runs));
  assert.equal(quote, quantile(counted, CLOCK.TARGET));
  assert.ok(quote > trimmedMean(runs), 'and it is above the trimmed mean');
});

test('the target holds up to par, then eases to TARGET_END and stops', () => {
  assert.equal(targetFor(1), CLOCK.TARGET);
  assert.equal(targetFor(CLOCK.PAR_STAGE), CLOCK.TARGET);
  assert.ok(targetFor(CLOCK.PAR_STAGE + 1) < CLOCK.TARGET, 'it starts moving past par');

  const end = CLOCK.PAR_STAGE + CLOCK.TIGHTEN_STAGES;
  assert.ok(Math.abs(targetFor(end) - CLOCK.TARGET_END) < 1e-9);
  assert.equal(targetFor(end + 40), CLOCK.TARGET_END, 'and never below it');
  assert.ok(CLOCK.TARGET_END >= 0.5, 'the late game aims at a typical clear, never a freak one');
});

test('past par the deadline tightens stage by stage and then holds', () => {
  const runs = spread(10000, 21000, 12);
  const seen = [];
  for (let step = 0; step <= CLOCK.TIGHTEN_STAGES + 5; step++) {
    const stage = CLOCK.PAR_STAGE + step;
    seen.push(stageDeadline(stage, history(stage, runs)));
  }

  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] <= seen[i - 1] + 1e-9, `the deadline must not loosen at step ${i}`);
  }
  assert.ok(seen.at(-1) < seen[0], 'it really does tighten');
  assert.equal(seen.at(-1), seen.at(-3), 'and holds once the target has settled');
});

test('what is asked for is always a run the record has plenty of', () => {
  // The old late game walked to the single fastest surviving run. This one stops at the
  // median of the trimmed clears times the resting margin, so at least half the clears on
  // record beat the deadline outright, before the margin is even counted.
  const runs = spread(12000, 30000, 20);
  for (let step = 0; step <= 40; step++) {
    const stage = CLOCK.PAR_STAGE + step;
    const counted = runsCounted(stage, history(stage, runs));
    const deadline = stageDeadline(stage, history(stage, runs));
    const median = quantile(counted, 0.5);
    assert.ok(deadline >= median * CLOCK.SLACK_END - 1e-9, `stage ${stage} undercut the median`);
  }
});

test('the freak fast run is trimmed off, so it never becomes the target', () => {
  // Ten ordinary runs and one that will never happen again. Deep past par the quote sits
  // on the ordinary runs, not on the fluke.
  const runs = [...Array(10).fill(20000), 1000];
  const stage = CLOCK.PAR_STAGE + 20;
  const counted = runsCounted(stage, history(stage, runs));

  assert.ok(!counted.includes(1000), 'the 1s run was thrown out with the extremes');
  assert.equal(quotedTime(stage, history(stage, runs)), 20000 * thinFor(counted.length));
});

// --- thin records are quoted wide ------------------------------------------------------

test('a record of one run is quoted wide, and the width tapers off as runs arrive', () => {
  assert.equal(thinFor(0), 1 + CLOCK.THIN_MARGIN);
  assert.ok(thinFor(1) < thinFor(0));
  assert.ok(thinFor(5) < thinFor(1));
  assert.equal(thinFor(CLOCK.CONFIDENT_N), 1, 'at CONFIDENT_N it is the plain quote');
  assert.equal(thinFor(CLOCK.CONFIDENT_N + 200), 1, 'and it never goes under 1');
});

test('a stage with one clear is measured against that clear, widened', () => {
  // One expert's debut clear is not a par. It is quoted with the thin margin on top, so the
  // second person through is not asked to match the first one's time plus nothing.
  const early = history(2, [40000]);
  assert.equal(expectedTime(2, early), 40000 * thinFor(1));
  assert.equal(stageDeadline(2, early), 40000 * thinFor(1) * slackFor(2));

  const stage = CLOCK.PAR_STAGE + 9;
  const late = history(stage, [40000]);
  assert.equal(stageDeadline(stage, late), 40000 * thinFor(1) * CLOCK.SLACK_END);
  assert.ok(stageDeadline(stage, late) > 40000, 'past par it is still not "beat it again"');
});

test('the thin margin is gone once the record is deep enough for the trim to work', () => {
  assert.equal(CLOCK.CONFIDENT_N, Math.ceil(1 / CLOCK.TRIM), 'the two are the same threshold');
  const times = history(4, settled(20000));
  assert.equal(expectedTime(4, times), 20000, 'no width on a settled record');
});

// --- the floor ----------------------------------------------------------------------------

test('no deadline is ever shorter than FLOOR_MS', () => {
  // A three-rope stage clears in two seconds once you know the game and takes a first-timer
  // ten to read. The record can only say the first; the floor says the second.
  const quick = history(1, settled(2000));
  assert.equal(stageDeadline(1, quick), CLOCK.FLOOR_MS);
  assert.equal(stageDeadline(1, {}, { 1: 2000 }), CLOCK.FLOOR_MS, 'pooled or not');

  const slow = history(20, settled(30000));
  assert.ok(stageDeadline(20, slow) > CLOCK.FLOOR_MS, 'and it never touches a real par');
});

// --- the model follows the player ----------------------------------------------------

test('getting faster tightens the deadline', () => {
  const stage = 10;
  const slow = history(stage, settled(60000));
  const fast = history(stage, settled(30000));
  assert.ok(stageDeadline(stage, fast) < stageDeadline(stage, slow));
});

test('board size is not an input, only the times are', () => {
  // Two stages, same recorded times, same stage number: the same deadline, whatever the
  // boards looked like. There is nothing in the model that could tell them apart.
  const a = history(12, [20000, 22000, 24000]);
  const b = history(12, [20000, 22000, 24000]);
  assert.equal(stageDeadline(12, a), stageDeadline(12, b));
});

// --- recording ------------------------------------------------------------------------

test('a run left sitting on screen is pulled back to something plausible', () => {
  const times = history(10, Array(6).fill(20000));
  recordClear(times, 10, 45 * 60 * 1000);

  const stored = times['10'].at(-1);
  assert.equal(stored, 20000 * CLOCK.OUTLIER);
  assert.ok(stored < 45 * 60 * 1000, 'the doorbell run does not set the deadline');
});

test('a genuinely fast or slow clear is left alone', () => {
  const times = history(10, Array(6).fill(20000));
  recordClear(times, 10, 12000);
  recordClear(times, 10, 34000);
  assert.deepEqual(
    times['10'].slice(-2),
    [12000, 34000],
    'OUTLIER is wide enough that real play is never clamped',
  );
});

test('the first ever clear has nothing to be judged against and is taken as it stands', () => {
  const times = {};
  recordClear(times, 1, 25000);
  assert.deepEqual(times['1'], [25000]);
});

test('runs age out oldest first', () => {
  const times = {};
  for (let i = 0; i < CLOCK.KEEP + 5; i++) recordClear(times, 1, 20000 + i);

  const kept = times['1'];
  assert.equal(kept.length, CLOCK.KEEP);
  assert.equal(kept.at(-1), 20000 + CLOCK.KEEP + 4, 'newest survives');
  assert.equal(kept[0], 20005, 'and the oldest five are gone');
});

// --- the running clock ------------------------------------------------------------

test('an untimed clock still measures, and never expires', () => {
  const clock = new StageClock();
  clock.begin(null);
  clock.tick(5000);

  assert.equal(clock.timed, false);
  assert.equal(clock.expired, false);
  assert.equal(clock.remaining, Infinity);
  assert.equal(clock.fraction, 1, 'meters sit full rather than empty');
  assert.equal(clock.elapsed, 5000, 'and the debut clear still produces a run');
});

test('a timed clock drains and expires exactly at zero', () => {
  const clock = new StageClock();
  clock.begin(10000);

  clock.tick(4000);
  assert.equal(clock.remaining, 6000);
  assert.equal(clock.fraction, 0.6);
  assert.equal(clock.expired, false);

  clock.tick(6000);
  assert.equal(clock.expired, true, 'expiry is at zero, not past it');
  assert.equal(clock.remaining, 0, 'and the readout never goes negative');

  clock.tick(9999);
  assert.equal(clock.remaining, 0);
});

test('beginning a stage resets the previous one', () => {
  const clock = new StageClock();
  clock.begin(10000);
  clock.tick(9000);
  clock.begin(20000);

  assert.equal(clock.elapsed, 0);
  assert.equal(clock.remaining, 20000);
});

// --- the readout ------------------------------------------------------------------

test('the readout counts in seconds, then in tenths, and names the untimed stage', () => {
  assert.equal(formatClock(Infinity), '∞');
  assert.equal(formatClock(95000), '1:35');
  assert.equal(formatClock(60000), '1:00');
  assert.equal(formatClock(9400), '0:10', 'rounded up: 9.4s left is not yet "9"');
  assert.equal(formatClock(4900), '4.9', 'inside the last seconds it switches to tenths');
  assert.equal(formatClock(0), '0.0');
  assert.equal(formatClock(-50), '0.0', 'and never shows a negative');
});

test('"0.0" means zero, not nearly zero', () => {
  // Rounding to nearest would put 0.0 on screen with up to 50ms still on the clock, and
  // 50ms is three frames the player can still grab a rope in. Every displayed value has to
  // be time they really have, so the tenths ceil exactly as the seconds above them do.
  assert.equal(formatClock(1), '0.1', 'a millisecond left is not none');
  assert.equal(formatClock(49), '0.1', 'and neither is the last half of a tenth');
  assert.equal(formatClock(100), '0.1');
  assert.equal(formatClock(101), '0.2', 'a tenth and a bit is still two tenths to run');
  assert.equal(formatClock(0), '0.0', 'only zero reads zero');
});

test('a finished duration is reported without the countdown tenths', () => {
  assert.equal(formatClock(4900, { tenths: false }), '0:05');
  assert.equal(formatClock(95000, { tenths: false }), '1:35');
});

// --- the shared pool -------------------------------------------------------------------

/** A par table as the server sends it: stage -> already-quoted ms. */
const pars = (stage, ms) => ({ [String(stage)]: ms });

test('the pool times a stage this player has never cleared', () => {
  // The rule this replaces: a debut board used to be untimed no matter what. It is the
  // whole point of pooling, and the thing a new player will notice first.
  assert.equal(stageDeadline(5, {}), null, 'nothing pooled, nothing to go on');
  assert.equal(stageDeadline(5, {}, pars(5, 20000)), 20000 * slackFor(5));
});

test('a stage nobody at all has cleared is still untimed', () => {
  assert.equal(stageDeadline(80, {}, pars(5, 20000)), null);
  assert.equal(stageDeadline(80, {}, {}), null);
});

test('the pool is quoted by exactly the model the device is', () => {
  // The server runs pooledTime over the raw pool and ships the answer; the client runs
  // expectedTime over its own history. They have to be the same three steps, or the two
  // populations are being asked different questions.
  const runs = spread(15000, 40000, 30);
  assert.equal(pooledTime(9, { 9: runs }), expectedTime(9, { 9: runs }));
  assert.equal(pooledTime(9, {}), null);
});

test('a malformed par is ignored rather than producing a NaN deadline', () => {
  // This arrives from the network and from localStorage, so it is not hypothetical. A NaN
  // limit is the worst outcome available: the clock is neither running nor off.
  for (const bad of [{ 5: 'soon' }, { 5: null }, { 5: 0 }, { 5: -1 }, { 5: NaN }]) {
    assert.equal(stageDeadline(5, {}, bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('a large pool still tightens past par', () => {
  // The same 400 runs filed against two stages, so the only difference is the target.
  const samples = spread(20000, 60000, 400);
  const pool = { [CLOCK.PAR_STAGE]: samples, [CLOCK.PAR_STAGE + CLOCK.TIGHTEN_STAGES]: samples };
  const early = pooledTime(CLOCK.PAR_STAGE, pool);
  const late = pooledTime(CLOCK.PAR_STAGE + CLOCK.TIGHTEN_STAGES, pool);
  assert.ok(late < early * 0.95, `expected a real tightening, got ${late} vs ${early}`);
  assert.equal(late, quantile(runsCounted(CLOCK.PAR_STAGE, pool), CLOCK.TARGET_END));
  assert.ok(late >= quantile(runsCounted(CLOCK.PAR_STAGE, pool), 0.5), 'never under the median');
});

test('a pool of one is measured against that one run, widened', () => {
  assert.equal(pooledTime(3, { 3: [25000] }), 25000 * thinFor(1));
  assert.ok(pooledTime(3, { 3: [25000] }) > 25000);
});

// --- when both the pool and the device answer -------------------------------------------

test('the looser of the two quotes is the deadline', () => {
  // The invariant the personal model got for free: nobody is asked for more than their own
  // record shows they can do. And the other way: a player faster than the pool is quoted
  // the pool's time rather than their own.
  const mine = history(50, settled(30000));
  assert.equal(stageDeadline(50, mine, pars(50, 5000)), 30000 * CLOCK.SLACK_END, 'own wins');
  assert.equal(stageDeadline(50, mine, pars(50, 45000)), 45000 * CLOCK.SLACK_END, 'pool wins');
});

test('the comparison is made before the margin, so the margin is applied once', () => {
  const mine = history(12, settled(30000));
  assert.equal(stageDeadline(12, mine, pars(12, 45000)), 45000 * slackFor(12));
});

test('the pool alone decides on a stage the player has never cleared', () => {
  // Worth pinning because it is the real cost of pooling rather than an oversight: there
  // is no own record to compare against, so the pool's number stands. The thin margin the
  // server applied and the floor are what protect a new player here.
  assert.equal(stageDeadline(50, {}, pars(50, 9000)), 9000 * CLOCK.SLACK_END);
});
