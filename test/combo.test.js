import assert from 'node:assert/strict';
import test from 'node:test';

import { COMBO } from '../src/config.js';
import { Rope } from '../src/rope.js';
import { comboName, comboWindow, cursedStep, ScoreKeeper } from '../src/scoring.js';
import { TangleTracker } from '../src/tangle.js';

/** ScoreKeeper in isolation: what a gesture is worth, and what a combo pot is worth. */

function horizontal(id, x, y, seg = 20, count = 6) {
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push({ x: x + i * seg, y });
  return new Rope(id, nodes, seg);
}

function vertical(id, x, y, seg = 20, count = 6) {
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push({ x, y: y + i * seg });
  return new Rope(id, nodes, seg);
}

/** Three horizontals crossed by one vertical, plus a clear rope off to the side. */
function board() {
  return [
    vertical(0, 60, 0, 20, 12),
    horizontal(1, 0, 40),
    horizontal(2, 0, 100),
    horizontal(3, 0, 160),
    horizontal(4, 600, 400),
  ];
}

function scored(distance = 500) {
  const score = new ScoreKeeper();
  score.beginStage(2000);
  score.beginMove();
  score.addDistance(distance);
  score.endMove();
  return score;
}

// --- precision points ------------------------------------------------------------------

test('mark + createdSinceMark: a clean pull creates nothing', () => {
  const ropes = board();
  const tracker = new TangleTracker(ropes);
  assert.equal(tracker.count, 3);

  tracker.mark();
  ropes[0].translate(900, 0); // straight out to empty space
  tracker.recount(0);

  assert.equal(tracker.count, 0);
  assert.equal(tracker.createdSinceMark(), 0);
});

test('mark + createdSinceMark: parking on another rope registers a fresh knot', () => {
  const ropes = board();
  const tracker = new TangleTracker(ropes);

  tracker.mark();
  // Off the three horizontals, but straight onto the rope parked in the corner.
  ropes[0].translate(600, 380);
  tracker.recount(0);

  assert.ok(tracker.createdSinceMark() > 0, 'the new crossing is counted');
});

test('precision points bank immediately, chain or no chain', () => {
  const ropes = board();
  const tracker = new TangleTracker(ropes);
  const score = scored();

  tracker.mark();
  ropes[0].translate(900, 0);
  tracker.recount(0);

  const result = score.award(tracker.commit());

  assert.equal(result.resolved, 3);
  assert.ok(result.points > 0);
  assert.equal(score.points, result.points, 'banked on the spot — no escrow to wait on');
  assert.equal(score.comboKnots, 0, 'and the combo pot is a separate thing entirely');
});

test('a precise, cheap pull outscores a sloppy expensive one', () => {
  const tight = scored(100);
  tight.award([{ i: 0, j: 1, resolved: 1, gap: 12 }]);

  const loose = scored(4000);
  loose.award([{ i: 0, j: 1, resolved: 1, gap: 900 }]);

  assert.ok(tight.points > loose.points, `${tight.points.toFixed(1)} > ${loose.points.toFixed(1)}`);
});

// --- the combo ----------------------------------------------------------------------

test('each knot is priced and banked into the run as it lands', () => {
  const score = scored();

  const first = score.addKnot();
  assert.equal(first, COMBO.KNOT_VALUE, 'the opening knot is worth a flat one');
  assert.equal(score.comboKnots, 1);
  assert.equal(score.comboScore, first);

  const second = score.addKnot();
  assert.ok(second > first, 'and every knot after it is worth more than the last');
  assert.ok(Math.abs(second - COMBO.KNOT_VALUE * (1 + COMBO.KNOT_MULT_STEP)) < 1e-9);
  assert.ok(Math.abs(score.comboScore - (first + second)) < 1e-9, 'accrued, not re-derived');
});

test('a long run is worth more than the same knots taken in short ones', () => {
  const long = scored();
  for (let k = 0; k < 8; k++) long.addKnot();
  const held = long.cashCombo(0, false).paid;

  let split = 0;
  for (let r = 0; r < 4; r++) {
    const short = scored();
    short.addKnot();
    short.addKnot();
    split += short.cashCombo(0, false).paid;
  }

  assert.ok(held > split, `holding eight (${held.toFixed(0)}) beats four twos (${split.toFixed(0)})`);
});

test('letting the window lapse is a landing — it banks in full', () => {
  const score = scored();
  for (let k = 0; k < 6; k++) score.addKnot();
  const cash = score.cashCombo(4, false);

  assert.equal(cash.cursed, 4, 'the multiplier survives');
  assert.equal(score.bestCombo, 6);
  assert.equal(score.bestCursed, 4);
});

test('cashing an empty run is a no-op', () => {
  const score = scored();
  assert.equal(score.cashCombo(7), null);
  assert.equal(score.points, 0);
});

test('the window stops tightening past the decay floor', () => {
  const floor = COMBO.DECAY_FLOOR_RUNG;
  assert.ok(comboWindow(floor - 1) > comboWindow(floor), 'it tightens up to the floor');
  assert.equal(comboWindow(floor), comboWindow(floor + 1), 'and is flat after it');
  assert.equal(comboWindow(floor), comboWindow(80), 'however far the run goes');
  assert.equal(comboWindow(1), COMBO.WINDOW_MS, 'the first knot gets the full window');
});

// --- the readout -------------------------------------------------------------------------

test('score is the raw point total, not a per-move average', () => {
  const score = new ScoreKeeper();
  score.beginStage(2000);

  for (let m = 0; m < 3; m++) {
    score.beginMove();
    score.addDistance(300);
    score.endMove();
    score.award([{ i: 0, j: m + 1, resolved: 1, gap: 60 }]);
  }

  const banked = score.points;
  assert.ok(banked > 0);
  assert.equal(score.score, banked);
  assert.ok(Math.abs(score.perMove - banked / 3) < 1e-9, 'the average survives separately');

  // The bug this replaces: a further move used to *lower* the number on screen. A long,
  // wasteful haul for one crossing is the clearest case — it is worth less per move than
  // anything before it, so the average has to fall while the total still rises.
  score.beginMove();
  score.addDistance(6000);
  score.endMove();
  score.award([{ i: 0, j: 9, resolved: 1, gap: 60 }]);

  assert.ok(score.score > banked, 'another untangle can only add to it');
  assert.ok(score.perMove < banked / 3, 'while the efficiency stat still dilutes');
});

test('the running pot is projected into the score, not hidden until it cashes', () => {
  const score = scored();
  score.award([{ i: 0, j: 1, resolved: 2, gap: 60 }]);
  const banked = score.points;
  score.addKnot();

  assert.equal(score.projected(0), banked, 'one knot is not a run and projects nothing');

  score.addKnot();
  assert.ok(score.projected(0) > banked, 'two makes a run, and it shows');
  const two = score.projected(0);
  score.addKnot();
  assert.ok(score.projected(0) > two, 'and it climbs with every knot');
  assert.ok(score.projected(8) > score.projected(0), 'and again with the curse');

  // Cashing cleanly must be a no-op on screen: the number was already correct.
  const shown = score.projected(8);
  score.cashCombo(8, false);
  assert.ok(Math.abs(score.score - shown) < 1e-9);
});

test('a bail is visible as the projected score collapsing to the bare knots', () => {
  const score = scored();
  for (let k = 0; k < 4; k++) score.addKnot();
  const accrued = score.comboScore;

  const promised = score.projected(5);
  score.cashCombo(5, true);
  assert.ok(score.score < promised, 'the forfeit is felt on the number the player watched');
  assert.ok(Math.abs(score.score - accrued) < 1e-9, 'it falls back to what the knots earned');
});

test('the combo ladder names exactly the rungs that can happen', () => {
  // Names are flavour and get rewritten; the shape of the ladder is what must hold.
  assert.equal(COMBO.NAMES.length, COMBO.MAX + 1, 'one slot per rung, indexed by multiplier');

  // CURSED_BASE is not a threshold anyone picked — it is the smallest value #advance can
  // produce, so it has to be derived from the same arithmetic rather than trusted. This
  // used to assert from a hardcoded 2, which named a rung the game could never reach and
  // left NAMES[2] as content no player would ever see.
  const opens = 1 + cursedStep(1);
  assert.equal(COMBO.CURSED_BASE, opens, 'the first nameable rung is the first reachable one');

  for (let rung = 0; rung < COMBO.CURSED_BASE; rung++) {
    assert.equal(COMBO.NAMES[rung], '', `x${rung} cannot happen, so it must not be named`);
  }
  for (let rung = COMBO.CURSED_BASE; rung <= COMBO.MAX; rung++) {
    assert.ok(COMBO.NAMES[rung], `cursed x${rung} needs a name`);
  }

  // Blanks rather than deletions: the list is indexed by the multiplier, so removing the
  // dead slots would slide every name down one and rename every rung above them.
  assert.equal(comboName(COMBO.CURSED_BASE), 'TRIPLE', 'the first reachable rung, by index');
  assert.ok(COMBO.NAMES[COMBO.MAX], 'and the rung that detonates gets the biggest one');
  assert.ok(!COMBO.NAMES[COMBO.MAX].includes('×'), 'a bare name, never a second x-number');
});

// --- heavy ropes ---------------------------------------------------------------------

test('weight scales the rung rather than replacing it', () => {
  const score = scored();
  score.addKnot(2);
  const second = score.addKnot(2);

  // Both compound: the second knot of a run off a double rope is worth twice the base,
  // times the rung it landed on.
  assert.ok(
    Math.abs(second - COMBO.KNOT_VALUE * 2 * (1 + COMBO.KNOT_MULT_STEP)) < 1e-9,
    'the ladder still climbs underneath the weight',
  );
});

