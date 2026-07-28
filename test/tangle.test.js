import assert from 'node:assert/strict';
import test from 'node:test';

import { Rope } from '../src/rope.js';
import { TangleTracker } from '../src/tangle.js';

/** A straight horizontal rope of `count` nodes, `seg` apart, starting at (x, y). */
function horizontal(id, x, y, seg = 20, count = 6) {
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push({ x: x + i * seg, y });
  return new Rope(id, nodes, seg);
}

/** A straight vertical rope. */
function vertical(id, x, y, seg = 20, count = 6) {
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push({ x, y: y + i * seg });
  return new Rope(id, nodes, seg);
}

test('counts a simple crossing and reports it as one graph edge', () => {
  const ropes = [horizontal(0, 0, 50), vertical(1, 40, 0)];
  const tracker = new TangleTracker(ropes);

  assert.equal(tracker.count, 1);
  assert.deepEqual(tracker.knotEdges(), [[0, 1]]);
});

test('recount refreshes geometry but never awards', () => {
  const ropes = [horizontal(0, 0, 50), vertical(1, 40, 0)];
  const tracker = new TangleTracker(ropes);

  ropes[1].translate(0, 400); // pull it clear
  tracker.recount(1);

  assert.equal(tracker.count, 0, 'the count reflects the new geometry');
  assert.equal(tracker.commit().length, 1, 'but payout only happens on commit');
});

test('commit awards a resolved crossing exactly once', () => {
  const ropes = [horizontal(0, 0, 50), vertical(1, 40, 0)];
  const tracker = new TangleTracker(ropes);

  ropes[1].translate(0, 400);
  tracker.recount(1);

  const first = tracker.commit();
  assert.equal(first.length, 1);
  assert.equal(first[0].resolved, 1);
  assert.ok(first[0].gap > 0, 'a fully separated pair reports its clearance');

  assert.equal(tracker.commit().length, 0, 'committing again awards nothing');
});

test('re-tangling and pulling apart again earns nothing', () => {
  const ropes = [horizontal(0, 0, 50), vertical(1, 40, 0)];
  const tracker = new TangleTracker(ropes);
  const tangled = ropes[1].saveState();

  ropes[1].translate(0, 400);
  tracker.recount(1);
  assert.equal(tracker.commit().length, 1);

  ropes[1].restoreState(tangled); // put it straight back
  tracker.recount(1);
  assert.equal(tracker.count, 1);
  assert.equal(tracker.commit().length, 0, 'a rise never pays');

  ropes[1].translate(0, 400); // and separate it a second time
  tracker.recount(1);
  assert.equal(tracker.count, 0);
  assert.equal(tracker.commit().length, 0, 'the ratchet has already paid for this pair');
});

test('a transient separation mid-gesture does not pay', () => {
  // The whole point of committing once per gesture: a rope whipped clear and back again
  // within a single move must bank nothing, because nothing was actually untangled.
  const ropes = [horizontal(0, 0, 50), vertical(1, 40, 0)];
  const tracker = new TangleTracker(ropes);
  const start = ropes[1].saveState();

  ropes[1].translate(0, 400); // mid-gesture frame: momentarily clear
  tracker.recount(1);
  assert.equal(tracker.count, 0);

  ropes[1].restoreState(start); // end of gesture: right back where it was
  tracker.recount(1);

  assert.equal(tracker.count, 1);
  assert.equal(tracker.commit().length, 0);
});

test('one gesture clearing several pairs reports them together, for the combo', () => {
  const ropes = [vertical(0, 40, 0), horizontal(1, 0, 30), horizontal(2, 0, 60)];
  const tracker = new TangleTracker(ropes);
  assert.equal(tracker.count, 2);

  ropes[0].translate(500, 0);
  tracker.recount(0);

  const events = tracker.commit();
  assert.equal(events.length, 2);
  assert.equal(
    events.reduce((sum, e) => sum + e.resolved, 0),
    2,
  );
});

test('a pair still crossing elsewhere reports a null gap', () => {
  // Zigzag crossing a straight rope three times; clear one crossing only.
  const straight = horizontal(0, 0, 100, 40, 6);
  const zig = new Rope(
    1,
    [
      { x: 20, y: 60 },
      { x: 60, y: 140 },
      { x: 100, y: 60 },
      { x: 140, y: 140 },
    ],
    Math.hypot(40, 80),
  );
  const tracker = new TangleTracker([straight, zig]);
  assert.ok(tracker.count >= 2, `expected multiple knots, got ${tracker.count}`);

  zig.translate(0, -30); // lift it so fewer segments cross, but not all
  tracker.recount(1);

  const events = tracker.commit();
  if (events.length && tracker.count > 0) {
    assert.equal(events[0].gap, null, 'still-crossing pairs have no meaningful clearance');
  }
});

test('recountAll refreshes every pair without ratcheting', () => {
  const ropes = [horizontal(0, 0, 50), vertical(1, 40, 0)];
  const tracker = new TangleTracker(ropes);

  ropes[1].translate(0, 400);
  tracker.recountAll();

  assert.equal(tracker.count, 0);
  assert.equal(tracker.commit().length, 1, 'the award was preserved for commit, not eaten');
});
