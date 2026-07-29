import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOCK } from '../src/config.js';
import {
  expectedTime,
  formatClock,
  recordClear,
  runsCounted,
  slackFor,
  slowestStruck,
  StageClock,
  stageDeadline,
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

// --- the average -------------------------------------------------------------------

test('trimmed mean throws away the extremes once there are enough to throw away', () => {
  // Ten samples: 10% off each end drops exactly one from each. The 1 and the 1000 are the
  // spikes the trim exists for — without them the mean is 5, with them it is over 100.
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

// --- the margin, up to par ----------------------------------------------------------

test('slack opens at SLACK_START and reaches exactly 1.0 at par', () => {
  assert.equal(slackFor(1), CLOCK.SLACK_START);
  assert.equal(slackFor(1), 1.4, 'the stated 40% for the first stages');
  assert.ok(Math.abs(slackFor(CLOCK.PAR_STAGE) - 1) < 1e-9, 'no margin at par');
});

test('slack falls steadily and then holds at 1.0 — it never goes under', () => {
  let previous = Infinity;
  for (let stage = 1; stage <= 80; stage++) {
    const slack = slackFor(stage);
    assert.ok(slack <= previous + 1e-12, `slack must not rise at stage ${stage}`);
    assert.ok(slack >= 1 - 1e-12, `slack must never drop below 1.0 (stage ${stage})`);
    previous = slack;
  }
  assert.equal(slackFor(CLOCK.PAR_STAGE + 40), 1);
});

test('an early stage is handed its average plus the margin', () => {
  // Ten identical 10s runs: the average is unambiguous, so the deadline is just the margin.
  const times = history(1, Array(10).fill(10000));
  assert.equal(expectedTime(1, times), 10000);
  assert.equal(stageDeadline(1, times), 14000, '10s average, 40% on top');
});

test('at par the deadline is the average itself', () => {
  const times = history(CLOCK.PAR_STAGE, Array(10).fill(10000));
  assert.equal(stageDeadline(CLOCK.PAR_STAGE, times), 10000);
});

// --- past par, the average tightens onto the faster runs -----------------------------

test('past par the slowest surviving run is struck off, one more per stage', () => {
  assert.equal(slowestStruck(CLOCK.PAR_STAGE), 0);
  assert.equal(slowestStruck(CLOCK.PAR_STAGE + 1), 1);
  assert.equal(slowestStruck(CLOCK.PAR_STAGE + 7), 7);
  assert.equal(slowestStruck(CLOCK.PAR_STAGE - 5), 0, 'nothing is struck before par');
});

test('the deadline walks down toward the fastest run and stops there', () => {
  // Twelve runs from 10s to 21s. The trim takes the 10s and the 21s off, leaving 11s..20s.
  const runs = spread(10000, 21000, 12);
  const seen = [];

  for (let step = 0; step <= 14; step++) {
    const stage = CLOCK.PAR_STAGE + step;
    seen.push(stageDeadline(stage, history(stage, runs)));
  }

  for (let i = 1; i < seen.length; i++) {
    assert.ok(seen[i] <= seen[i - 1] + 1e-9, `the deadline must not loosen at step ${i}`);
  }

  // Ten survive the trim, so by ten stages past par only the fastest of them is left.
  const trimmedFastest = 11000;
  assert.equal(seen.at(-1), trimmedFastest, 'it arrives at the fastest surviving run');
  assert.ok(seen[0] > trimmedFastest, 'having started at the average of all of them');
});

test('what is left standing is always a run the player actually recorded', () => {
  // The point of striking runs rather than shrinking a multiplier: the tightest deadline
  // reachable is a time already on the record, so it can never describe an impossible one.
  const runs = spread(12000, 30000, 10);
  for (let step = 0; step <= 30; step++) {
    const stage = CLOCK.PAR_STAGE + step;
    const deadline = stageDeadline(stage, history(stage, runs));
    assert.ok(
      deadline >= Math.min(...runsCounted(stage, history(stage, runs))),
      `stage ${stage} asked for better than anything on record`,
    );
  }
});

test('the last run is never struck, however far past par the stage is', () => {
  const runs = spread(12000, 30000, 10);
  const far = CLOCK.PAR_STAGE + 500;
  assert.equal(runsCounted(far, history(far, runs)).length, 1);
  assert.ok(stageDeadline(far, history(far, runs)) > 0);
});

test('the freak fast run is trimmed off, so it never becomes the target', () => {
  // Ten ordinary runs and one that will never happen again. Deep past par the deadline
  // converges on the fastest *ordinary* run, not on the fluke.
  const runs = [...Array(10).fill(20000), 1000];
  const stage = CLOCK.PAR_STAGE + 20;
  const counted = runsCounted(stage, history(stage, runs));

  assert.deepEqual(counted, [20000], 'the 1s run was thrown out with the extremes');
  assert.equal(stageDeadline(stage, history(stage, runs)), 20000);
});

test('a stage with one clear is measured against that clear, par or not', () => {
  const early = history(2, [40000]);
  assert.ok(stageDeadline(2, early) > 40000, 'early it gets a margin on top');

  const late = history(CLOCK.PAR_STAGE + 9, [40000]);
  assert.equal(stageDeadline(CLOCK.PAR_STAGE + 9, late), 40000, 'late it gets exactly it');
});

// --- the model follows the player ----------------------------------------------------

test('getting faster tightens the deadline', () => {
  const stage = 10;
  const slow = history(stage, Array(10).fill(60000));
  const fast = history(stage, Array(10).fill(30000));
  assert.ok(stageDeadline(stage, fast) < stageDeadline(stage, slow));
});

test('board size is not an input — only the times are', () => {
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

test('a finished duration is reported without the countdown tenths', () => {
  assert.equal(formatClock(4900, { tenths: false }), '0:05');
  assert.equal(formatClock(95000, { tenths: false }), '1:35');
});
