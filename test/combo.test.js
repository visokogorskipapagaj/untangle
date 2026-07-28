import assert from 'node:assert/strict';
import test from 'node:test';

import { COMBO } from '../src/config.js';
import { Rope } from '../src/rope.js';
import { ScoreKeeper } from '../src/scoring.js';
import { TangleTracker } from '../src/tangle.js';

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

test('a landed combo multiplies, and counts as the stage best', () => {
  const ropes = board();
  const tracker = new TangleTracker(ropes);
  const score = new ScoreKeeper();
  score.beginStage(2000);

  tracker.mark();
  score.beginMove();
  ropes[0].translate(900, 0);
  tracker.recount(0);
  score.addDistance(500);
  score.endMove();

  // Third consecutive landing, so the chain is at 3.
  const result = score.award(tracker.commit(), tracker.createdSinceMark() > 0, 3);

  assert.equal(result.resolved, 3);
  assert.equal(result.combo, 3);
  assert.equal(result.killed, false);
  assert.equal(score.bestCombo, 3);
  assert.equal(score.points, 0, 'held in escrow until the chain ends');

  const pot = score.pendingPoints;
  score.cashChain(3);
  assert.ok(Math.abs(score.points - pot * 3) < 1e-9);
});

test('clearing many crossings in one gesture does NOT inflate the combo', () => {
  const score = new ScoreKeeper();
  score.beginStage(2000);
  score.beginMove();
  score.addDistance(300);
  score.endMove();

  // Nine crossings in a single pull, but it is only the first link of the chain.
  const events = Array.from({ length: 9 }, (_, k) => ({ i: 0, j: k + 1, resolved: 1, gap: 50 }));
  const result = score.award(events, false, 1);

  assert.equal(result.resolved, 9);
  assert.equal(result.combo, 1, 'the chain drives the multiplier, not the gesture');

  const pot = score.pendingPoints;
  score.cashChain(1);
  assert.ok(Math.abs(score.points - pot) < 1e-9, 'a lone move pays at x1');
});

test('a killed combo still shows its number but pays at x1', () => {
  const clean = (() => {
    const ropes = board();
    const tracker = new TangleTracker(ropes);
    const score = new ScoreKeeper();
    score.beginStage(2000);
    tracker.mark();
    score.beginMove();
    ropes[0].translate(900, 0);
    tracker.recount(0);
    score.addDistance(500);
    score.endMove();
    score.award(tracker.commit(), false, 3);
    return score.cashChain(3, false);
  })();

  const ropes = board();
  const tracker = new TangleTracker(ropes);
  const score = new ScoreKeeper();
  score.beginStage(2000);

  tracker.mark();
  score.beginMove();
  ropes[0].translate(900, 0);
  tracker.recount(0);
  score.addDistance(500);
  score.endMove();

  const award = score.award(tracker.commit(), true, 3);
  const killed = score.cashChain(3, true);

  assert.equal(award.combo, 3, 'the callout still reports what was earned');
  assert.equal(award.killed, true);
  assert.equal(killed.multiplier, 1, 'but it pays at x1');
  assert.ok(
    killed.paid < clean.paid,
    `killed ${killed.paid.toFixed(1)} should be under clean ${clean.paid.toFixed(1)}`,
  );
  assert.ok(
    Math.abs(killed.paid * 3 - clean.paid) < 1e-6,
    'exactly the multiplier is forfeit, nothing else',
  );
  assert.equal(score.bestCombo, 1, 'a killed combo is not the stage best');
});

test('the combo ladder covers every rung', () => {
  // Names are flavour and get rewritten; the shape of the ladder is what must hold.
  assert.equal(COMBO.NAMES.length, COMBO.MAX + 1, 'one name per rung, plus the unused 0');
  assert.equal(COMBO.NAMES[1], '', 'a single untangle is not a combo');
  for (let rung = 2; rung <= COMBO.MAX; rung++) {
    assert.ok(COMBO.NAMES[rung], `rung ${rung} needs a name`);
  }
});

test('a chain past the cap still reports the capped multiplier', () => {
  const score = new ScoreKeeper();
  score.beginStage(2000);
  score.beginMove();
  score.addDistance(100);
  score.endMove();

  const result = score.award([{ i: 0, j: 1, resolved: 1, gap: 50 }], false, 14);
  assert.equal(result.combo, COMBO.MAX);
  assert.equal(score.cashChain(14).multiplier, COMBO.MAX);
});
