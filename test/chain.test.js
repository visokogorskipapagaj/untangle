import assert from 'node:assert/strict';
import test from 'node:test';

import { COMBO, CURSED, STAGE } from '../src/config.js';
import { generateStage, stageSpec } from '../src/generator.js';
import { Renderer } from '../src/render.js';
import { Rope } from '../src/rope.js';
import { comboWindow, cursedStep } from '../src/scoring.js';
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

test('a detonated rope leaves the board without shifting pair indices', () => {
  const ropes = [vertical(0, 60, 0, 20, 12), horizontal(1, 0, 40), horizontal(2, 0, 100)];
  const tracker = new TangleTracker(ropes);
  assert.equal(tracker.count, 2);

  ropes[0].removed = true;
  ropes[0].markDirty();
  tracker.recount(0);

  assert.equal(tracker.count, 0, 'its knots are gone');
  assert.equal(tracker.knotsBetween(1, 2), 0, 'other pairs are untouched');
  assert.equal(ropes.length, 3, 'the array is intact, so indices stay valid');

  // The freed knots are still real untangles and must be committable.
  assert.equal(
    tracker.commit().reduce((sum, e) => sum + e.resolved, 0),
    2,
  );
});

test('knotsBetween reports live pair state', () => {
  const ropes = [vertical(0, 60, 0, 20, 12), horizontal(1, 0, 40)];
  const tracker = new TangleTracker(ropes);

  assert.ok(tracker.knotsBetween(0, 1) > 0);
  assert.equal(tracker.knotsBetween(1, 0), tracker.knotsBetween(0, 1), 'symmetric');
  assert.equal(tracker.knotsBetween(0, 0), 0, 'a rope does not cross itself');

  ropes[0].translate(900, 0);
  tracker.recount(0);
  assert.equal(tracker.knotsBetween(0, 1), 0);
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

// --- the late-stage growth curve --------------------------------------------------------

test('the board stops standing still after GROWTH_FROM', () => {
  // Both curves pin at their caps before this — every stage past 20 used to be exactly the
  // same size as the last, and only the cursed ropes kept arriving.
  const at = STAGE.GROWTH_FROM;
  const before = stageSpec(at);
  const after = stageSpec(at + STAGE.GROWTH_EVERY);

  assert.ok(after.ropeCount > before.ropeCount, 'ropes climb');
  assert.ok(after.targetKnots > before.targetKnots, 'and so do knots');
});

test('growth is 20% per five stages, spread across them rather than stepped', () => {
  const base = stageSpec(STAGE.GROWTH_FROM);
  const five = stageSpec(STAGE.GROWTH_FROM + STAGE.GROWTH_EVERY);

  const ratio = five.targetKnots / base.targetKnots;
  assert.ok(
    Math.abs(ratio - (1 + STAGE.GROWTH_STEP)) < 0.02,
    `five stages on should be a fifth bigger, got ${ratio.toFixed(3)}`,
  );

  // Spread, not stepped: every stage in between is bigger than the one before it, so the
  // ramp never stalls for four stages and then lurches.
  let last = base.targetKnots;
  for (let s = STAGE.GROWTH_FROM + 1; s <= STAGE.GROWTH_FROM + STAGE.GROWTH_EVERY; s++) {
    const now = stageSpec(s).targetKnots;
    assert.ok(now >= last, `stage ${s} must not shrink`);
    last = now;
  }
  assert.ok(last > base.targetKnots, 'and the run as a whole climbs');
});

test('nothing before GROWTH_FROM is touched by the ramp', () => {
  for (let stage = 1; stage <= STAGE.GROWTH_FROM; stage++) {
    const spec = stageSpec(stage);
    const early = Math.min(
      STAGE.ROPES_MAX,
      Math.floor(STAGE.ROPES_BASE + stage * STAGE.ROPES_PER_STAGE),
    );
    assert.equal(spec.ropeCount, early, `stage ${stage} keeps the early rope curve`);
  }
});

test('both counts stop at a ceiling and hold there', () => {
  // Solvability, not taste: ropes have to fit side by side, and a board whose knots outrun
  // any move budget is impossible rather than hard.
  for (const stage of [40, 60, 90, 200]) {
    const spec = stageSpec(stage);
    assert.ok(spec.ropeCount <= STAGE.ROPES_CEILING, `stage ${stage} ropes`);
    assert.ok(spec.targetKnots <= STAGE.KNOTS_CEILING, `stage ${stage} knots`);
  }

  const far = stageSpec(200);
  assert.equal(far.ropeCount, STAGE.ROPES_CEILING, 'and it really does reach them');
  assert.equal(far.targetKnots, STAGE.KNOTS_CEILING);
});

test('a stage at the ceiling still generates a board that fits and is funded', () => {
  for (const stage of [40, 60]) {
    const info = generateStage(stage, 1600, 900, 4242 + stage);
    assert.ok(info.fits, `stage ${stage} must fit the viewport`);
    assert.ok(info.knots > 0, 'and be a real puzzle');
    assert.ok(info.moves.ideal >= info.moves.cover, 'funded against its weighted cover');
    assert.ok(info.ropes.some((r) => !r.cursed), 'and not be entirely black rope');
  }
});

test('phones play a thinned board once there is anything to thin', () => {
  for (let stage = 1; stage <= 40; stage++) {
    const full = stageSpec(stage).ropeCount;
    const phone = stageSpec(stage, true).ropeCount;

    if (full <= STAGE.PHONE_FROM_ROPES) {
      assert.equal(phone, full, `stage ${stage} is already sparse — nothing to thin`);
    } else {
      const want = Math.max(STAGE.PHONE_FROM_ROPES, Math.round(full * STAGE.PHONE_SCALE));
      assert.equal(phone, want, `stage ${stage}: ${full} ropes should thin to ${want}`);
      assert.ok(phone >= STAGE.PHONE_FROM_ROPES, 'and never below the floor');
      assert.ok(phone < full, 'and always fewer than the full board');
    }
  }
});

test('knots come down with the ropes on a phone, without a rule of their own', () => {
  // The knot target is capped against the rope count, so halving the board halves what it
  // can hold. A separate phone rule for knots would be a second thing to keep in sync.
  for (const stage of [12, 20, 30, 40]) {
    const full = stageSpec(stage);
    const phone = stageSpec(stage, true);
    assert.ok(phone.targetKnots < full.targetKnots, `stage ${stage} should carry fewer knots`);
    assert.ok(phone.targetKnots <= Math.round(phone.ropeCount * 2.5), 'within what it can hold');
  }
});

test('a phone stage still generates a real, funded, fitting board', () => {
  for (const stage of [8, 20, 30, 40]) {
    const info = generateStage(stage, 390, 780, 77 * stage, { phone: true });
    assert.ok(info.fits, `stage ${stage} must fit a phone viewport`);
    assert.ok(info.knots > 0, 'and be a real puzzle');
    assert.ok(info.moves.ideal >= info.moves.cover, 'funded against its weighted cover');
  }
});

test('cursed ropes multiply past EXTRA_FROM, one every EXTRA_EVERY stages', () => {
  const count = (stage) =>
    generateStage(stage, 1600, 900, 7000 + stage).ropes.filter((r) => r.cursed).length;

  for (let stage = CURSED.FROM; stage <= CURSED.EXTRA_FROM; stage++) {
    assert.equal(count(stage), 1, `stage ${stage} carries exactly one`);
  }

  assert.equal(count(CURSED.EXTRA_FROM + 1), 2, 'the stage after EXTRA_FROM is the second');
  assert.equal(count(CURSED.EXTRA_FROM + CURSED.EXTRA_EVERY), 2, 'and it holds for the run');
  assert.equal(count(CURSED.EXTRA_FROM + CURSED.EXTRA_EVERY + 1), 3, 'then a third');
});

test('the count is capped by share of the board, not left to climb forever', () => {
  // Every cursed rope taxes what it touches and costs ten to grab. Unchecked the ladder
  // would eventually mark most of a stage, which is not a harder puzzle.
  for (const stage of [40, 60, 90]) {
    const info = generateStage(stage, 1600, 900, 31 * stage);
    const cursed = info.ropes.filter((r) => r.cursed).length;
    const cap = Math.max(1, Math.floor(info.ropes.length * CURSED.MAX_SHARE));

    assert.ok(cursed <= cap, `stage ${stage}: ${cursed} cursed of ${info.ropes.length} ropes`);
    assert.ok(info.ropes.some((r) => !r.cursed), 'and never the whole board');
  }
});

test('the x10 detonation is actually reachable on the stages that carry a curse', () => {
  // The cursed multiplier climbs only by hauling ropes *out of* a curse's field, and each
  // rope in it can be harvested once — putting one back is a fresh knot, which is a fumble
  // that ends the run. So the highest multiplier a stage can ever pay is fixed the moment
  // it generates, and it used to come out around x5 against a x10 threshold: the payoff
  // was arithmetically impossible on its debut stages, not merely hard.
  //
  // This is the guard rail on that. It fails if the curse stops being seated on the hubs,
  // if it stops being grown longer, or if cursedStep goes back to paying bare weight.
  const SEEDS = 12;
  const FLOOR = 6;

  for (let stage = CURSED.FROM; stage <= 40; stage++) {
    let reachable = 0;
    for (let seed = 0; seed < SEEDS; seed++) {
      const info = generateStage(stage, 1600, 900, 1234 + seed * 97 + stage);
      const tracker = new TangleTracker(info.ropes);

      // Every rope sitting in some curse's field — any of them feeds the same multiplier.
      const field = new Set();
      info.ropes.forEach((rope, c) => {
        if (!rope.cursed) return;
        info.ropes.forEach((other, i) => {
          if (i !== c && !other.cursed && tracker.knotsBetween(i, c) > 0) field.add(i);
        });
      });

      // Harvest lightest first: the opener is worth its own step like every haul after it.
      const weights = [...field].map((i) => info.ropes[i].weight).sort((a, b) => a - b);
      const max = weights.reduce((acc, w) => acc + cursedStep(w), 1);
      if (max >= COMBO.MAX) reachable++;
    }

    assert.ok(
      reachable >= FLOOR,
      `stage ${stage}: only ${reachable}/${SEEDS} seeds can ever reach x${COMBO.MAX}`,
    );
  }
});

test('every cursed rope is priced and drawn as one', () => {
  const info = generateStage(CURSED.EXTRA_FROM + CURSED.EXTRA_EVERY + 1, 1600, 900, 515);
  const cursed = info.ropes.filter((r) => r.cursed);
  assert.ok(cursed.length >= 2, 'a late stage carries several');

  const plain = info.ropes.find((r) => !r.cursed && r.weight === 1);
  for (const rope of cursed) {
    assert.equal(rope.weight, CURSED.GRAB_COST, 'each costs the full grab');
    assert.ok(rope.strokeWidth > plain.strokeWidth, 'and each is visibly fatter');
  }
});

test('the drag tax is folded into the budget the stage is funded with', () => {
  for (let stage = CURSED.FROM; stage <= CURSED.FROM + 6; stage++) {
    const info = generateStage(stage, 1600, 900, 88 * stage);
    // Every one of them, not just the first: a late stage carries several, and a rope
    // caught on any of them is taxed.
    const cursedIndexes = info.ropes.map((r, i) => (r.cursed ? i : -1)).filter((i) => i >= 0);
    if (!cursedIndexes.length) continue;

    const tracker = new TangleTracker(info.ropes);
    info.ropes.forEach((rope, i) => {
      if (rope.cursed) {
        assert.equal(info.weights[i], CURSED.GRAB_COST);
      } else if (cursedIndexes.some((c) => tracker.knotsBetween(i, c) > 0)) {
        assert.equal(
          info.weights[i],
          rope.weight * CURSED.DRAG_TAX,
          `rope ${i} crosses a cursed rope and must be priced at double — flat, however ` +
            `many of them it is caught on`,
        );
      } else {
        assert.equal(info.weights[i], rope.weight);
      }
    });

    assert.ok(info.moves.ideal >= info.moves.cover, 'par covers the weighted cost');
  }
});

test('the chain window is short enough to demand pace, long enough to be real', () => {
  // Guard rail rather than a preference, so it has to be loose enough to leave the tuning
  // alone. The window is not a reaction time: it runs in real time from the drop before,
  // so it pays for reaching the next rope and for hauling it as well as for deciding. A
  // 500ms haul off the front of it is why the floor here is well clear of a frame.
  assert.ok(COMBO.WINDOW_MS >= 600, 'has to outlast a haul, or nothing is ever landable');
  assert.ok(COMBO.WINDOW_MS <= 2500, 'past a couple of seconds there is no pressure left');
  assert.ok(COMBO.WINDOW_MIN_MS <= COMBO.WINDOW_MS, 'the floor cannot be above the start');
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
    knots: [{ x: 10, y: 10 }],
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

test('the chain window opens at WINDOW_MS and tightens by WINDOW_DECAY per rung', () => {
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

test('the detonation fires once, when the cursed multiplier crosses MAX', () => {
  // The check the game uses. A heavy rope can jump 9 -> 11 without ever equalling 10.
  const fires = (before, after) => before < COMBO.MAX && after >= COMBO.MAX;

  assert.equal(fires(9, 10), true, 'landing exactly on the threshold pays');
  assert.equal(fires(9, 11), true, 'vaulting over it still pays');
  assert.equal(fires(8, 11), true);
  assert.equal(fires(2, 4), false, 'nowhere near it');
  assert.equal(fires(11, 13), false, 'already past — it only ever fires once');
});
