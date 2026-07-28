import assert from 'node:assert/strict';
import test from 'node:test';

import { CURSED, HEAVY } from '../src/config.js';
import { generateStage } from '../src/generator.js';
import { MoveBudget } from '../src/moves.js';
import { minimumVertexCover } from '../src/solver.js';
import { TangleTracker } from '../src/tangle.js';

test('weighted cover: a heavy hub is worth avoiding', () => {
  // Star: vertex 0 crosses 1, 2 and 3. Unweighted the answer is obviously "move 0".
  const star = [
    [0, 1],
    [0, 2],
    [0, 3],
  ];
  assert.equal(minimumVertexCover(4, star), 1);

  // Make the hub cost 5 and it becomes cheaper to move all three leaves instead.
  assert.equal(minimumVertexCover(4, star, [5, 1, 1, 1]), 3);

  // At cost 2 the hub is still the bargain.
  assert.equal(minimumVertexCover(4, star, [2, 1, 1, 1]), 2);
});

test('weighted cover: ties resolve to the cheaper side', () => {
  const single = [[0, 1]];
  assert.equal(minimumVertexCover(2, single, [3, 1]), 1);
  assert.equal(minimumVertexCover(2, single, [1, 3]), 1);
  assert.equal(minimumVertexCover(2, single, [3, 3]), 3);
});

test('weighted cover: falls back to unweighted when weights are all 1', () => {
  const triangle = [
    [0, 1],
    [1, 2],
    [0, 2],
  ];
  assert.equal(minimumVertexCover(3, triangle, [1, 1, 1]), minimumVertexCover(3, triangle));
});

test('weighted cover: no edges costs nothing however heavy the ropes', () => {
  assert.equal(minimumVertexCover(4, [], [3, 3, 3, 3]), 0);
});

test('the budget spends a heavy rope at its full cost', () => {
  const budget = new MoveBudget();
  budget.bank = 0;
  budget.beginStage(5, 0);

  budget.spend(1);
  budget.spend(3);
  assert.equal(budget.used, 4);
  assert.equal(budget.stageLeft, 1);

  budget.spend(2); // one move past the grant
  assert.equal(budget.overdraft, 1);
  assert.equal(budget.exhausted, true, 'no bank to cover it');
});

test('heavy ropes stay clear of the early stages, then appear', () => {
  const heaviest = (stage) => {
    const info = generateStage(stage, 1600, 900, 555 + stage);
    return Math.max(...info.ropes.map((r) => r.weight));
  };

  for (let stage = 1; stage < HEAVY.DOUBLE_FROM; stage++) {
    assert.equal(heaviest(stage), 1, `stage ${stage} must be all light ropes`);
  }
  assert.ok(heaviest(HEAVY.DOUBLE_FROM) >= 2, 'doubles arrive on schedule');
});

test('a heavy rope always crosses something, and never dominates the stage', () => {
  for (let stage = HEAVY.DOUBLE_FROM; stage <= 20; stage++) {
    for (let s = 0; s < 4; s++) {
      const info = generateStage(stage, 1600, 900, 31 * stage + s);
      const heavy = info.ropes.filter((r) => r.weight > 1);
      const share = stage > HEAVY.LATE_FROM ? HEAVY.LATE_MAX_SHARE : HEAVY.MAX_SHARE;

      assert.ok(
        heavy.length <= Math.floor(info.ropes.length * share),
        `stage ${stage}: ${heavy.length} heavy of ${info.ropes.length} exceeds the ${share} share cap`,
      );

      // A heavy rope with no knots would be decoration, not a decision.
      const tracker = new TangleTracker(info.ropes);
      const degree = new Array(info.ropes.length).fill(0);
      for (const rec of tracker.pairs.values()) {
        degree[rec.i] += rec.count;
        degree[rec.j] += rec.count;
      }
      for (const rope of heavy) {
        assert.ok(
          degree[rope.id] > 0,
          `stage ${stage} seed ${s}: heavy rope ${rope.id} crosses nothing`,
        );
      }

      for (const rope of info.ropes) {
        const allowed = rope.cursed ? rope.weight === CURSED.GRAB_COST : rope.weight <= 3;
        assert.ok(allowed && rope.weight >= 1, `rope ${rope.id} weight ${rope.weight}`);
        assert.ok(rope.strokeWidth >= 1, 'stroke width derives from weight');
      }
      assert.ok(
        info.ropes.filter((r) => r.cursed).length <= 1,
        'at most one cursed rope per stage',
      );
    }
  }
});

test('triple ropes only become possible from their stage onward', () => {
  let sawTriple = false;
  for (let stage = 1; stage < HEAVY.TRIPLE_FROM; stage++) {
    for (let s = 0; s < 6; s++) {
      const info = generateStage(stage, 1600, 900, 909 * stage + s);
      assert.ok(
        info.ropes.every((r) => r.weight <= 2),
        `stage ${stage} produced a triple before ${HEAVY.TRIPLE_FROM}`,
      );
    }
  }
  for (let stage = HEAVY.TRIPLE_FROM; stage <= 24; stage++) {
    for (let s = 0; s < 6; s++) {
      const info = generateStage(stage, 1600, 900, 909 * stage + s);
      if (info.ropes.some((r) => r.weight === 3)) sawTriple = true;
    }
  }
  assert.ok(sawTriple, 'triples do eventually appear');
});

test('the stage budget is funded against weighted cost, not rope count', () => {
  // A stage carrying heavy ropes must never be granted less than its weighted cover.
  for (let stage = HEAVY.DOUBLE_FROM; stage <= 18; stage++) {
    const info = generateStage(stage, 1600, 900, 1234 + stage);
    assert.ok(
      info.moves.ideal >= info.moves.cover,
      `stage ${stage}: ideal ${info.moves.ideal} underfunds cover ${info.moves.cover}`,
    );
    assert.equal(info.weights.length, info.ropes.length);
  }
});
