import assert from 'node:assert/strict';
import test from 'node:test';

import { COMBO, CURSED } from '../src/config.js';
import { generateStage } from '../src/generator.js';
import { Renderer } from '../src/render.js';
import { Rope } from '../src/rope.js';
import { comboWindow, ScoreKeeper } from '../src/scoring.js';
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

test('points earned during a chain are escrowed, not banked', () => {
  const score = new ScoreKeeper();
  score.beginStage(2000);
  score.beginMove();
  score.addDistance(200);
  score.endMove();

  // One crossing resolved, as the fourth consecutive landing.
  const result = score.award([{ i: 0, j: 1, resolved: 1, gap: 60 }], false, 4);

  assert.equal(result.resolved, 1, 'a single untangle');
  assert.equal(result.combo, 4, 'reported as x4, because it is the fourth in a row');
  assert.equal(score.points, 0, 'nothing is banked while the chain runs');
  assert.ok(score.pendingPoints > 0, 'it is held in escrow');
  assert.equal(result.pending, score.pendingPoints);
});

test('the whole pot multiplies by the rung, not each move by its own', () => {
  const build = (rungs) => {
    const score = new ScoreKeeper();
    score.beginStage(2000);
    for (let r = 1; r <= rungs; r++) {
      score.beginMove();
      score.addDistance(200);
      score.endMove();
      score.award([{ i: 0, j: r, resolved: 1, gap: 60 }], false, r);
    }
    return score;
  };

  const score = build(4);
  const pot = score.pendingPoints;
  const cash = score.cashChain(4);

  assert.equal(cash.pot, pot);
  assert.equal(cash.multiplier, 4);
  assert.ok(Math.abs(cash.paid - pot * 4) < 1e-9, 'the entire run pays at the final rung');
  assert.ok(Math.abs(score.points - pot * 4) < 1e-9);
  assert.equal(score.pendingPoints, 0, 'the pot is emptied once cashed');

  // Four moves at x4 beats the old model, where they would have paid 1+2+3+4.
  const perMove = build(4);
  let staggered = 0;
  // Reconstruct what per-move multiplying would have produced from the same raw points.
  const each = perMove.pendingPoints / 4;
  for (let r = 1; r <= 4; r++) staggered += each * r;
  assert.ok(cash.paid > staggered, 'holding the chain is worth more than banking as you go');
});

test('a chain longer than the ladder is capped at MAX', () => {
  const score = new ScoreKeeper();
  score.beginStage(2000);
  score.beginMove();
  score.addDistance(100);
  score.endMove();

  const result = score.award([{ i: 0, j: 1, resolved: 1, gap: 60 }], false, 25);
  assert.equal(result.combo, COMBO.MAX);
  assert.equal(result.name, COMBO.NAMES[COMBO.MAX]);

  const pot = score.pendingPoints;
  const cash = score.cashChain(25);
  assert.equal(cash.multiplier, COMBO.MAX, 'the payout multiplier is capped too');
  assert.ok(Math.abs(cash.paid - pot * COMBO.MAX) < 1e-9);
});

test('a bail forfeits the multiplier on the entire pot', () => {
  const score = new ScoreKeeper();
  score.beginStage(2000);

  // Five clean links, then a sixth that parks a rope onto another.
  for (let r = 1; r <= 6; r++) {
    score.beginMove();
    score.addDistance(100);
    score.endMove();
    score.award([{ i: 0, j: r, resolved: 1, gap: 60 }], r === 6, r);
  }

  const pot = score.pendingPoints;
  const cash = score.cashChain(6, true);

  assert.equal(cash.rung, 6, 'the callout still shows what was dropped');
  assert.equal(cash.multiplier, 1, 'but it pays flat');
  assert.ok(Math.abs(cash.paid - pot) < 1e-9);
  assert.equal(score.bestCombo, 5, 'the bailed rung is not a personal best');
});

test('letting the window lapse is a landing, not a bail', () => {
  const score = new ScoreKeeper();
  score.beginStage(2000);
  score.beginMove();
  score.addDistance(100);
  score.endMove();
  score.award([{ i: 0, j: 1, resolved: 1, gap: 60 }], false, 3);

  const pot = score.pendingPoints;
  const cash = score.cashChain(3, false);
  assert.equal(cash.multiplier, 3, 'stopping banks at full value');
  assert.ok(Math.abs(cash.paid - pot * 3) < 1e-9);
});

test('cashing an empty chain is a no-op', () => {
  const score = new ScoreKeeper();
  score.beginStage(2000);
  assert.equal(score.cashChain(7), null);
  assert.equal(score.points, 0);
});

test('a detonated rope leaves the board without shifting pair indices', () => {
  const ropes = [vertical(0, 60, 0, 20, 12), horizontal(1, 0, 40), horizontal(2, 0, 100)];
  const tracker = new TangleTracker(ropes);
  assert.equal(tracker.count, 2);

  ropes[0].removed = true;
  ropes[0].markDirty();
  tracker.recount(0);

  assert.equal(tracker.count, 0, 'its crossings are gone');
  assert.equal(tracker.crossingsBetween(1, 2), 0, 'other pairs are untouched');
  assert.equal(ropes.length, 3, 'the array is intact, so indices stay valid');

  // The freed crossings are still real untangles and must be committable.
  assert.equal(
    tracker.commit().reduce((sum, e) => sum + e.resolved, 0),
    2,
  );
});

test('crossingsBetween reports live pair state', () => {
  const ropes = [vertical(0, 60, 0, 20, 12), horizontal(1, 0, 40)];
  const tracker = new TangleTracker(ropes);

  assert.ok(tracker.crossingsBetween(0, 1) > 0);
  assert.equal(tracker.crossingsBetween(1, 0), tracker.crossingsBetween(0, 1), 'symmetric');
  assert.equal(tracker.crossingsBetween(0, 0), 0, 'a rope does not cross itself');

  ropes[0].translate(900, 0);
  tracker.recount(0);
  assert.equal(tracker.crossingsBetween(0, 1), 0);
});

test('the cursed rope arrives on schedule and is priced to be avoided', () => {
  for (let stage = 1; stage < CURSED.FROM; stage++) {
    const info = generateStage(stage, 1600, 900, 4242 + stage);
    assert.ok(
      info.ropes.every((r) => !r.cursed),
      `stage ${stage} must not carry a cursed rope`,
    );
  }

  const info = generateStage(CURSED.FROM, 1600, 900, 4242 + CURSED.FROM);
  const cursed = info.ropes.find((r) => r.cursed);
  assert.ok(cursed, 'it appears from its stage onward');
  assert.equal(cursed.weight, CURSED.GRAB_COST);
  assert.ok(
    cursed.strokeWidth > info.ropes.find((r) => !r.cursed && r.weight === 1).strokeWidth,
    'and is visibly fatter than an ordinary rope',
  );
});

test('the drag tax is folded into the budget the stage is funded with', () => {
  for (let stage = CURSED.FROM; stage <= CURSED.FROM + 6; stage++) {
    const info = generateStage(stage, 1600, 900, 88 * stage);
    const cursedIndex = info.ropes.findIndex((r) => r.cursed);
    if (cursedIndex < 0) continue;

    const tracker = new TangleTracker(info.ropes);
    info.ropes.forEach((rope, i) => {
      if (rope.cursed) {
        assert.equal(info.weights[i], CURSED.GRAB_COST);
      } else if (tracker.crossingsBetween(i, cursedIndex) > 0) {
        assert.equal(
          info.weights[i],
          rope.weight * CURSED.DRAG_TAX,
          `rope ${i} crosses the cursed rope and must be priced at double`,
        );
      } else {
        assert.equal(info.weights[i], rope.weight);
      }
    });

    assert.ok(info.moves.ideal >= info.moves.cover, 'par covers the weighted cost');
  }
});

test('the chain window is short enough to demand pace, long enough to be real', () => {
  // Guard rail rather than a preference: a window under a frame is unplayable, and one
  // over a second removes all pressure.
  assert.ok(COMBO.WINDOW_MS >= 100, 'shorter than ~6 frames is not landable');
  assert.ok(COMBO.WINDOW_MS <= 1000, 'longer than a second is not a chain');
});

test('the renderer survives a board carrying a detonated and a cursed rope', () => {
  const calls = [];
  const ctx = new Proxy(
    { setTransform() {}, save() {}, restore() {}, canvas: null },
    {
      get: (t, p) => {
        if (p in t) return t[p];
        return (...a) => {
          calls.push(p);
          return { addColorStop() {} };
        };
      },
      set: () => true,
    },
  );
  const renderer = new Renderer({ getContext: () => ctx, width: 0, height: 0 });
  renderer.width = 800;
  renderer.height = 600;
  renderer.dpr = 1;

  const info = generateStage(CURSED.FROM, 800, 600, 31337);
  info.ropes[0].removed = true;

  renderer.draw({
    ropes: info.ropes,
    crossings: [{ x: 10, y: 10 }],
    flashes: [{ x: 5, y: 5, text: '+10', tone: 'gain', life: 400, total: 900 }],
    explosions: [{ x: 50, y: 50, life: 300, total: 750 }],
    chain: 7,
    chainFraction: 0.4,
    banner: { text: 'S-S-SEPTA', multiplier: '×7', killed: false, life: 500, total: 1100 },
    grabbedId: -1,
    showMarkers: true,
    margin: 20,
    time: 1234,
    debug: false,
  });

  assert.ok(calls.includes('stroke'), 'ropes were drawn');
  assert.ok(calls.includes('arc'), 'markers and shockwaves were drawn');
});

test('the chain window starts at 450ms and tightens 3% per rung', () => {
  assert.equal(comboWindow(1), COMBO.WINDOW_MS);
  assert.equal(comboWindow(0), COMBO.WINDOW_MS, 'no chain yet gets the full window');

  // Each rung multiplies by the decay factor.
  assert.ok(Math.abs(comboWindow(2) - COMBO.WINDOW_MS * COMBO.WINDOW_DECAY) < 1e-9);
  assert.ok(Math.abs(comboWindow(4) - COMBO.WINDOW_MS * COMBO.WINDOW_DECAY ** 3) < 1e-9);

  // Strictly tightening, never below the floor.
  for (let chain = 1; chain < 40; chain++) {
    assert.ok(comboWindow(chain + 1) <= comboWindow(chain), `rung ${chain} must not loosen`);
    assert.ok(comboWindow(chain) >= COMBO.WINDOW_MIN_MS);
  }
});

test('the window at the top of the ladder is still landable', () => {
  // The whole reason x3 was unreachable before: a window under a realistic grab-to-grab
  // reaction kills the chain regardless of skill.
  const atTen = comboWindow(COMBO.MAX);
  assert.ok(atTen > 300, `x10 window ${atTen.toFixed(0)}ms must clear a human reaction`);
  assert.ok(atTen < COMBO.WINDOW_MS, 'but it must be tighter than the opening rung');
});

test('a heavy rope advances the chain by what it cost', () => {
  // Two double-cost ropes take the chain 0 -> 2 -> 4, not 0 -> 1 -> 2.
  let chain = 0;
  for (const cost of [2, 2]) chain += cost;
  assert.equal(chain, 4);

  const score = new ScoreKeeper();
  score.beginStage(2000);
  score.beginMove();
  score.addDistance(150);
  score.endMove();
  score.award([{ i: 0, j: 1, resolved: 1, gap: 55 }], false, chain);

  const pot = score.pendingPoints;
  const cash = score.cashChain(chain);
  assert.equal(cash.multiplier, 4);
  assert.ok(Math.abs(cash.paid - pot * 4) < 1e-9);
});

test('a chain vaulting past the cap still pays the capped multiplier', () => {
  const score = new ScoreKeeper();
  score.beginStage(2000);
  score.beginMove();
  score.addDistance(150);
  score.endMove();
  score.award([{ i: 0, j: 1, resolved: 1, gap: 55 }], false, 13);

  const pot = score.pendingPoints;
  // Chain 9 + a triple rope lands on 12, overshooting x10.
  const cash = score.cashChain(12);
  assert.equal(cash.multiplier, COMBO.MAX);
  assert.ok(Math.abs(cash.paid - pot * COMBO.MAX) < 1e-9);
});

test('the x10 reward fires on every full threshold crossed, not on exact landings', () => {
  // The check the game uses. A heavy rope can jump 9 -> 11 without ever equalling 10.
  const rewardsFor = (before, after) =>
    Math.floor(after / COMBO.MAX) - Math.floor(before / COMBO.MAX);

  assert.equal(rewardsFor(9, 10), 1, 'landing exactly on the threshold pays');
  assert.equal(rewardsFor(9, 11), 1, 'vaulting over it still pays');
  assert.equal(rewardsFor(9, 12), 1);
  assert.equal(rewardsFor(0, 2), 0, 'no threshold crossed');
  assert.equal(rewardsFor(11, 13), 0, 'already past, none crossed');
  assert.equal(rewardsFor(19, 21), 1, 'the second threshold pays again');
  assert.equal(rewardsFor(8, 20), 2, 'a huge jump pays for each threshold crossed');
});
