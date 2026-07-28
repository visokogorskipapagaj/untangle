import assert from 'node:assert/strict';
import test from 'node:test';

import { COMBO, CURSED, ROPE } from '../src/config.js';
import { Game } from '../src/game.js';
import { Rope } from '../src/rope.js';
import { comboName, comboWindow, cursedStep } from '../src/scoring.js';
import { TangleTracker } from '../src/tangle.js';

/**
 * These drive a real Game, because every rule under test here is about *when* things are
 * read — the starter window burning while a rope is held, the deadline being latched at
 * the drop rather than at the end of the settle — and none of it exists in ScoreKeeper.
 *
 * The rope solver is deliberately bypassed: gestures translate a rope outright instead of
 * being dragged node by node, so the board is exact and the assertions are about the chain
 * rules rather than about where Jakobsen relaxation happened to leave things.
 */

const WIDTH = 1600;
const HEIGHT = 900;

function stubHud() {
  return {
    calls: [],
    hideSolved() {},
    hideGameOver() {},
    hideTitle() {},
    showSolved(s) {
      this.calls.push(['solved', s]);
    },
    showGameOver(s) {
      this.calls.push(['gameover', s]);
    },
    showMoveDelta() {},
    showBankDelta() {},
    shudder() {},
    setStats(s) {
      this.stats = s;
    },
    get anyOverlayOpen() {
      return false;
    },
  };
}

function horizontal(id, x, y, count = 8, seg = 20, weight = 1) {
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push({ x: x + i * seg, y });
  const rope = new Rope(id, nodes, seg);
  rope.weight = weight;
  return rope;
}

function vertical(id, x, y, count = 14, seg = 20, weight = 1) {
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push({ x, y: y + i * seg });
  const rope = new Rope(id, nodes, seg);
  rope.weight = weight;
  return rope;
}

/**
 * Six verticals, each crossed by its own horizontal, well inside the margins. Every rope
 * can be pulled clear on its own, so a chain can be run out link by link.
 *
 * The last pair is ballast that no test touches: without it a long chain clears the whole
 * board, the stage ends mid-test, and the chain gets cashed by the solve rather than by
 * the rule under test.
 */
function ladderBoard(weights = []) {
  const ropes = [];
  for (let k = 0; k < 6; k++) {
    const x = 200 + k * 200;
    ropes.push(vertical(k * 2, x, 200, 8, 20, weights[k] || 1));
    ropes.push(horizontal(k * 2 + 1, x - 60, 260, 7));
  }
  ropes.push(vertical(90, 1450, 600, 8), horizontal(91, 1390, 660, 7));
  return ropes;
}

/**
 * What the cursed multiplier reads after opening on a rope of this weight.
 *
 * Spelled as the rule rather than as a number: the multiplier starts neutral at 1 and
 * every haul out of a curse's field — the opener included — is worth `cursedStep`.
 */
const opened = (weight = 1) => 1 + cursedStep(weight);

/** Index of the k-th pullable vertical. */
const V = (k) => k * 2;

/** `moves` is the total the player actually has: stage grant plus bank. */
function makeGame(ropes, { moves = 200 } = {}) {
  const game = new Game({
    renderer: { resize() {}, draw() {} },
    hud: stubHud(),
    progress: { maxStage: 1, total: 0, best: {}, options: { distinct: false, markers: true } },
    baseSeed: 1,
    debug: false,
  });

  game.width = WIDTH;
  game.height = HEIGHT;
  game.margin = 30;
  game.ropes = ropes;
  game.tracker = new TangleTracker(ropes);
  game.score.beginStage(Math.hypot(WIDTH, HEIGHT));
  game.budget.bank = 0; // the starting cushion would otherwise skew the budget tests
  game.budget.beginStage(moves, 0);
  game.tracker.collectPoints(game.knotMarkers);
  game.state = 'playing';
  return game;
}

/** Steps the clock the way the main loop would, honouring the per-frame dt clamp. */
function advance(game, ms, step = 16) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    game.update(Math.min(step, ms - elapsed), 0);
  }
}

/**
 * One gesture: grab, displace, optionally dawdle with the rope in hand, drop.
 *
 * Returns without running the settle — `land()` does that — so a test can assert on the
 * gap between the drop and the evaluation, which is the point of several of them.
 */
function drag(game, ropeIndex, dx, dy, holdMs = 0) {
  const rope = game.ropes[ropeIndex];
  // The end node, never the middle: on these boards the middle of a rope sits exactly on
  // its crossing, where onGrab's nearest-rope search is a coin flip between the two.
  const node = rope.nodes[0];
  assert.ok(game.onGrab(node.x, node.y, false), `rope ${ropeIndex} should be grabbable`);
  assert.equal(game.grab.ropeIndex, ropeIndex, `the grab took rope ${ropeIndex}, not a neighbour`);

  rope.translate(dx, dy);
  game.score.addDistance(600); // comfortably over MOVE_EPSILON_U
  game.tracker.recount(ropeIndex);

  if (holdMs) advance(game, holdMs);
  game.onRelease();
}

/** Runs the post-release settle to completion, which is what evaluates the gesture. */
function settleOut(game, step = 16) {
  for (let guard = 0; game.settle && guard < 400; guard++) game.update(step, 0);
  assert.equal(game.settle, null, 'the settle should have finished');
}

function land(game, ropeIndex, dx, dy, holdMs = 0) {
  drag(game, ropeIndex, dx, dy, holdMs);
  settleOut(game);
}

/** Pull the k-th vertical clear of its horizontal. */
const clear = (game, k, holdMs = 0) => land(game, V(k), 0, -170, holdMs);

// --- the combo counts knots ---------------------------------------------------------------

test('one knot is not a combo — nothing is shown and nothing is owed', () => {
  const game = makeGame(ladderBoard());

  clear(game, 0);

  assert.equal(game.chain, 1);
  assert.equal(game.banner, null, 'nothing to shout about yet');
  assert.equal(game.score.comboValue(game.cursedMult), 0, 'and nothing at stake');
  assert.ok(game.chainTimer > 0, 'the clock, however, is already running');
});

test('a second knot inside the window makes it a combo', () => {
  const game = makeGame(ladderBoard());

  clear(game, 0);
  clear(game, 1);

  assert.equal(game.chain, 2);
  assert.ok(game.score.comboValue(game.cursedMult) > 0, 'now there is something at stake');
});

test('a leisurely second drop does NOT make a combo', () => {
  // The whole reason the clock starts at the first knot. It used to begin at x2, which
  // left the first one armed indefinitely: any second drop, whenever it came, was a double.
  const game = makeGame(ladderBoard());

  clear(game, 0);
  assert.equal(game.chain, 1);

  advance(game, comboWindow(1) + 500); // wander off and come back
  assert.equal(game.chain, 0, 'the run expired');

  clear(game, 1);
  assert.equal(game.chain, 1, 'so this is a fresh first knot, not a double');
  assert.equal(game.banner, null, 'and no callout was earned');
});

test('a run that never reached two knots pays nothing at all', () => {
  const game = makeGame(ladderBoard());

  clear(game, 0);
  const banked = game.score.points;
  assert.ok(banked > 0, 'the gesture still earned its precision points');

  advance(game, comboWindow(1) + 400);

  assert.equal(game.score.points, banked, 'but the one-knot run paid nothing');
  assert.equal(game.score.comboScore, 0, 'and dropped what it had accrued');
});

test('the combo counts knots, not drops — one pull that rips three apart is three rungs', () => {
  // Three horizontals crossed by one vertical: hauling the vertical clear takes all three.
  const game = makeGame([
    vertical(0, 400, 100, 16),
    horizontal(1, 340, 200, 7),
    horizontal(2, 340, 280, 7),
    horizontal(3, 340, 360, 7),
    vertical(8, 1300, 600, 8),
    horizontal(9, 1240, 660, 7),
  ]);

  land(game, 0, 300, 0);

  assert.equal(game.chain, 3, 'one drop, three knots, three rungs');
  assert.ok(game.score.comboValue(game.cursedMult) > 0, 'and it is a combo straight away');
});

test('the rung climbs one per knot, whatever the rope weighs', () => {
  // Weight used to advance the rung, so a triple rope opened a chain at x3 from cold and a
  // following double landed it on x5 — no start, and a readout that jumped then fell.
  const game = makeGame(ladderBoard([3, 2, 1, 2]));

  clear(game, 0);
  assert.equal(game.chain, 1, 'a x3 rope taking one knot is one rung');

  clear(game, 1);
  assert.equal(game.chain, 2, 'a x2 rope taking one knot is one more — x2, not x5');

  clear(game, 2);
  assert.equal(game.chain, 3);
});

test('the rung has no ceiling', () => {
  const game = makeGame(ladderBoard());
  for (let k = 0; k < 6; k++) clear(game, k);
  assert.equal(game.chain, 6, 'still climbing');
  assert.ok(game.score.comboValue(game.cursedMult) > 0);
});

test('a combo gets exactly one callout, at the moment it pays', () => {
  // It used to fire twice: once on landing the rung, once on cashing it. Two "x3" banners
  // a beat apart read as landing the same triple back to back.
  const game = makeGame(ladderBoard());

  clear(game, 0);
  clear(game, 1);
  clear(game, 2);
  assert.equal(game.chain, 3);
  assert.equal(game.banner, null, 'silent while it climbs — the indicator carries that');

  advance(game, comboWindow(3) + 60);
  assert.equal(game.chain, 0, 'lapsed');
  assert.ok(game.banner, 'and now, once, the payout');
  assert.equal(game.banner.multiplier, '3 KNOTS');
  assert.ok(game.banner.payout);
});

test('knot scores fly into the combo total once there is a total to fly into', () => {
  const game = makeGame(ladderBoard());

  clear(game, 0);
  assert.equal(game.flashes.at(-1).fly, false, 'the first knot has nowhere to go yet');

  clear(game, 1);
  const flash = game.flashes.at(-1);
  assert.equal(flash.fly, true, 'the second flies');
  assert.equal(flash.toX, game.width / 2, 'to the indicator, which is centred');
  assert.ok(flash.toY > 0 && flash.toY < 200, 'and sits under the decay bar');
});

// --- the window runs in real time --------------------------------------------------------

test('the window burns while the player is holding a rope', () => {
  const game = makeGame(ladderBoard());
  clear(game, 0);

  const started = game.chainTimer;
  const rope = game.ropes[V(1)];
  game.onGrab(rope.nodes[0].x, rope.nodes[0].y, false);
  advance(game, 160);

  assert.ok(
    game.chainTimer <= started - 140,
    `holding a rope must not pause the clock (${started.toFixed(0)} -> ${game.chainTimer.toFixed(0)})`,
  );
});

test('the bar the player watches is the deadline they are racing', () => {
  const game = makeGame(ladderBoard());
  clear(game, 0);
  clear(game, 1);

  const window = comboWindow(game.chain);
  const before = game.chainTimer;

  advance(game, 100);
  const idle = game.hud.stats.chainFraction;
  assert.ok(Math.abs(idle - (before - 100) / window) < 0.03, 'drains while idle');

  const rope = game.ropes[V(2)];
  game.onGrab(rope.nodes[0].x, rope.nodes[0].y, false);
  advance(game, 100);
  // Proportional to the window, not a flat fraction: 100ms is a tenth of a 1000ms window
  // and a fifteenth of a 1500ms one, so a hard 0.1 here only ever tested the tuning.
  assert.ok(
    game.hud.stats.chainFraction < idle - 90 / window,
    'and keeps draining with a rope in hand',
  );
});

test('the meter is live from the priming drop, not from x2', () => {
  const game = makeGame(ladderBoard());
  assert.equal(game.hud.stats?.chainFraction ?? 0, 0);

  clear(game, 0);
  game.update(16, 0);
  assert.equal(game.hud.stats.chain, 1);
  assert.ok(game.hud.stats.chainFraction > 0, 'a running deadline the player can see');
});

test('holding a rope past the window ends the old chain but primes a new one', () => {
  const game = makeGame(ladderBoard());
  clear(game, 0);
  clear(game, 1);
  clear(game, 2);
  assert.equal(game.chain, 3);

  const projected = game.score.projected(game.cursedMult);

  // Grab, dawdle well past the window, then drop perfectly cleanly.
  clear(game, 3, comboWindow(3) + 400);

  // The drop banks its own precision points on top, so this is a floor, not an equality.
  assert.ok(
    game.score.points >= projected - 1e-6,
    'the old chain banked at the rung it reached — lapsing is a landing, not a bail',
  );
  assert.equal(game.chain, 1, 'and the late-but-clean drop primes a fresh chain');
  assert.equal(game.score.comboKnots, 1, 'whose knots are its own, not the old potticket');
});

// --- the verdict is latched at the drop ---------------------------------------------------

test('a rope dropped inside the window lands, even though the settle outlasts it', () => {
  const game = makeGame(ladderBoard());
  clear(game, 0);
  clear(game, 1);

  advance(game, game.chainTimer - 40, 8);
  assert.ok(
    game.chainTimer > 0 && game.chainTimer < ROPE.SETTLE_MS,
    `sliver, shorter than a settle (${game.chainTimer.toFixed(0)}ms)`,
  );

  drag(game, V(2), 0, -170);
  assert.equal(game.chain, 2, 'not evaluated yet — the settle is still running');

  settleOut(game);
  assert.equal(game.chain, 3, 'the drop was inside the window, so the rung counts');
});

test('the window lapsing mid-settle cannot cash a chain from behind', () => {
  const game = makeGame(ladderBoard());
  clear(game, 0);
  clear(game, 1);

  advance(game, game.chainTimer - 20, 8);
  drag(game, V(2), 0, -170);

  for (let t = 0; t < ROPE.SETTLE_MS; t += 16) {
    game.update(16, 0);
    if (game.settle) assert.equal(game.chain, 2, 'no cash-out while a drop is pending');
  }
  assert.equal(game.chain, 3);
});

test('a rope that drifts onto a neighbour during the settle is not a fumble', () => {
  const game = makeGame(ladderBoard());
  clear(game, 0);
  drag(game, V(1), 0, -170);

  // The settle is the game's own unscored relaxation; simulate it drifting the rope onto
  // a rope elsewhere on the board. It is moved onto a *different* rope, not back onto the
  // one it just cleared, so the resolution itself still stands at commit time.
  game.ropes[V(1)].translate(-200, 170);
  game.tracker.recount(V(1));
  assert.ok(game.tracker.createdSinceMark() > 0, 'the drift really did make a fresh knot');
  settleOut(game);

  assert.equal(game.chain, 2, 'the drop is what is judged, not where the settle left it');
});

test('parking a rope on another one bails the chain and strips the multipliers', () => {
  const game = makeGame(ladderBoard());
  clear(game, 0);
  clear(game, 1);
  clear(game, 2);
  clear(game, 3);
  assert.equal(game.chain, 4);

  // What the run would have been worth had a cursed multiplier been riding on it.
  const accrued = game.score.comboScore;
  game.cursedMult = 5;
  const promised = game.score.comboValue(game.cursedMult);
  assert.ok(promised > accrued, 'there is a multiplier to lose');

  const banked = game.score.points;

  // Drop the next rope straight onto a neighbour's horizontal.
  land(game, V(4), -200, 60);

  assert.equal(game.chain, 0, 'the chain is gone');
  assert.equal(game.cursedMult, 0);
  assert.ok(game.banner?.killed, 'and it died on screen');

  const paid = game.score.points - banked;
  assert.ok(paid > 0, 'the knots still paid');
  assert.ok(paid < promised, 'but the cursed multiplier was forfeit');
});

// --- the cursed combo ----------------------------------------------------------------------

/** A cursed rope crossed by two ropes, plus ordinary pairs to build a normal run on. */
function cursedBoard(fieldWeights = [1, 1]) {
  const cursed = vertical(99, 1000, 160, 14, 20, CURSED.GRAB_COST);
  cursed.cursed = true;
  return [
    cursed, // 0
    horizontal(50, 940, 260, 7, 20, fieldWeights[0]), // 1 — crosses the curse
    horizontal(51, 940, 360, 7, 20, fieldWeights[1]), // 2 — crosses the curse
    vertical(0, 200, 200, 8), // 3
    horizontal(1, 140, 260, 7), // 4
    vertical(2, 500, 200, 8), // 5
    horizontal(3, 440, 260, 7), // 6
    vertical(60, 1400, 600, 8), // 7 — ballast
    horizontal(61, 1340, 660, 7), // 8
  ];
}

test('the curse cannot open a multiplier cold — there is nothing to multiply', () => {
  const game = makeGame(cursedBoard());

  land(game, 1, 0, 260);

  assert.equal(game.cursedMult, 0, 'no run was going, so no multiplier');
  assert.equal(game.chain, 1, 'it is just the first knot of one');
});

test('a heavy rope off the curse used to open at x4 from cold — now it is one knot', () => {
  const game = makeGame(cursedBoard([2, 1]));

  land(game, 1, 0, 260);
  assert.equal(game.cursedMult, 0);
  assert.equal(game.chain, 1);
});

test('a knot off the curse while a run is going opens the multiplier', () => {
  const game = makeGame(cursedBoard());

  land(game, 3, 0, -170); // an ordinary knot starts the run
  assert.equal(game.chain, 1);

  land(game, 1, 0, 260); // now one off the curse
  assert.equal(game.cursedMult, opened());
  assert.equal(game.chain, 2, 'and it is still a knot, so the rung climbs too');
});

test('the multiplier acts on everything the run accrued, including knots before it', () => {
  const game = makeGame(cursedBoard());

  land(game, 3, 0, -170);
  land(game, 5, 0, -170);
  const accrued = game.score.comboScore;
  assert.ok(accrued > 0);

  land(game, 1, 0, 260); // off the curse
  assert.equal(game.cursedMult, opened());
  assert.ok(
    game.score.comboValue(game.cursedMult) > game.score.comboScore,
    'the whole run is multiplied, not just what came after',
  );
  assert.ok(
    Math.abs(game.score.comboValue(game.cursedMult) - game.score.comboScore * opened()) <
      1e-9,
  );
});

test('inside a cursed combo the multiplier climbs by rope weight, uncapped', () => {
  const game = makeGame(cursedBoard([1, 3]));

  land(game, 3, 0, -170); // start a run
  land(game, 1, 0, 260); // off the curse -> x2
  assert.equal(game.cursedMult, opened());

  land(game, 2, 0, 300); // a weight-3 rope off the curse
  assert.equal(game.cursedMult, opened() + cursedStep(3), 'weight climbs the multiplier');
});

test('a cursed combo burns the window faster', () => {
  const game = makeGame(cursedBoard());
  land(game, 3, 0, -170);
  land(game, 1, 0, 260);
  assert.equal(game.cursedMult, opened());

  const started = game.chainTimer;
  advance(game, 100, 10);
  const burned = started - game.chainTimer;
  assert.ok(
    Math.abs(burned - 100 * COMBO.CURSED_BURN) < 12,
    `100ms should burn ~${100 * COMBO.CURSED_BURN}ms of window, burned ${burned.toFixed(0)}`,
  );
});

test('the multiplier is a property of the run and survives ordinary knots', () => {
  const game = makeGame(cursedBoard());

  land(game, 3, 0, -170);
  land(game, 1, 0, 260); // cursed x2
  assert.equal(game.cursedMult, opened());

  land(game, 5, 0, -170); // an ordinary rope, nowhere near the curse
  assert.equal(game.cursedMult, opened(), 'still multiplying');
  assert.equal(game.chain, 3, 'and the knot still counts');
  assert.equal(game.hud.stats.cursedMult, opened(), 'the HUD is told');
});

test('the multiplier dies with the run', () => {
  const game = makeGame(cursedBoard());
  land(game, 3, 0, -170);
  land(game, 1, 0, 260);
  assert.equal(game.cursedMult, opened());

  advance(game, comboWindow(game.chain) * 2 + 200);
  assert.equal(game.chain, 0);
  assert.equal(game.cursedMult, 0, 'the next run starts uncursed');
});

test('the cursed rope itself is not in its own field', () => {
  const game = makeGame(cursedBoard());

  land(game, 3, 0, -170); // start a run
  land(game, 0, -300, 0); // haul the black rope off both its ropes

  assert.equal(game.cursedMult, 0, 'it cannot open or climb the multiplier');
  assert.ok(game.chain >= 2, 'its knots still count as ordinary rungs');
  assert.equal(game.ropes[0].removed, false, 'and it detonates nothing by itself');
});

// --- boards carrying several black ropes ------------------------------------------------------

/**
 * Two cursed ropes, each with its own pair of ropes caught on it, plus an ordinary pair to
 * open a run on. Nothing reaches from one curse's field into the other's.
 */
function twoCursedBoard() {
  const a = vertical(97, 600, 160, 14, 20, CURSED.GRAB_COST);
  const b = vertical(98, 1100, 160, 14, 20, CURSED.GRAB_COST);
  a.cursed = true;
  b.cursed = true;
  return [
    a, // 0 — curse A
    b, // 1 — curse B
    horizontal(10, 540, 260, 7), // 2 — on A
    horizontal(11, 540, 360, 7), // 3 — on A
    horizontal(20, 1040, 260, 7), // 4 — on B
    horizontal(21, 1040, 360, 7), // 5 — on B
    vertical(0, 200, 200, 8), // 6 — ordinary pair, well clear of both
    horizontal(1, 140, 260, 7), // 7
    vertical(60, 1400, 600, 8), // 8 — ballast
    horizontal(61, 1340, 660, 7), // 9
  ];
}

test('the second black rope taxes exactly like the first', () => {
  // The tax used to be read off `findIndex`, so only the first cursed rope on the board
  // had a field at all and everything caught on the others dragged at face value.
  const game = makeGame(twoCursedBoard());

  const before = game.budget.totalLeft;
  land(game, 4, 0, 260); // caught on B, the second one in the array
  assert.equal(before - game.budget.totalLeft, CURSED.DRAG_TAX, 'taxed by the one it is on');
});

test('a rope caught on two black ropes is taxed once, not twice', () => {
  // Compounding reads as fair and plays as broken: a rope between two curses would cost
  // four moves, and between three, eight — past the whole budget for touching one rope.
  const straddler = horizontal(30, 560, 300, 30);
  const game = makeGame([...twoCursedBoard(), straddler]);
  const index = game.ropes.length - 1;

  assert.ok(game.tracker.knotsBetween(index, 0) > 0, 'it really is on A');
  assert.ok(game.tracker.knotsBetween(index, 1) > 0, 'and on B');

  const before = game.budget.totalLeft;
  land(game, index, 0, 140); // haul it clear of both
  assert.equal(before - game.budget.totalLeft, CURSED.DRAG_TAX, 'flat, however many it is on');
});

test('a x10 detonates the black rope the run fed on, not whichever sits first', () => {
  const game = makeGame(twoCursedBoard());

  land(game, 6, 0, -170); // an ordinary knot opens the run
  assert.equal(game.chain, 1);

  land(game, 4, 0, 260); // off curse B — the run is now cursed, and fed on B
  assert.equal(game.cursedMult, opened());
  assert.equal(game.curseTarget, 1, 'B is what this run is eating');

  // Stand the multiplier up just under the threshold and take one more knot off B.
  game.cursedMult = COMBO.MAX - 1;
  land(game, 5, 0, 260);

  assert.ok(game.cursedMult >= COMBO.MAX, 'the multiplier crossed x10');
  assert.equal(game.ropes[1].removed, true, 'B — the one the work was done on — is gone');
  assert.equal(game.ropes[0].removed, false, 'A is untouched, it was never part of this run');
  assert.ok(
    game.explosions.length > 0,
    'and it goes off where it stood, not somewhere across the board',
  );
});

test('the target dies with the run, so the next one picks its own', () => {
  const game = makeGame(twoCursedBoard());

  land(game, 6, 0, -170);
  land(game, 4, 0, 260); // cursed off B
  assert.equal(game.curseTarget, 1);

  advance(game, comboWindow(game.chain) * 2 + 400); // let it lapse
  assert.equal(game.chain, 0, 'the run is over');
  assert.equal(game.curseTarget, -1, 'and it took its target with it');
});

// --- what the callout says ------------------------------------------------------------------

/** The state the renderer is actually handed, which is where the indicator reads from. */
function drawn(game) {
  let state = null;
  game.renderer = { resize() {}, draw: (s) => (state = s) };
  game.render(0);
  return state;
}

test('a normal combo pays out as a knot count and a number, with no name', () => {
  // The ladder names are the curse's. A name on every clean double meant the game shouted
  // every few seconds, which is the same as never shouting.
  const game = makeGame(ladderBoard());
  clear(game, 0);
  clear(game, 1);
  clear(game, 2);

  advance(game, comboWindow(3) + 60);

  assert.equal(game.banner.multiplier, '3 KNOTS');
  assert.equal(game.banner.text, '', 'no name on an ordinary run');
  assert.ok(game.banner.payout, 'the number it paid, though, is the whole point');
});

test('a normal run is not named while it is running either', () => {
  const game = makeGame(ladderBoard());
  clear(game, 0);
  clear(game, 1);

  const state = drawn(game);
  assert.equal(state.chain, 2, 'the indicator has a knot count');
  assert.ok(state.comboValue > 0, 'and a total');
  assert.equal(state.comboName, '', 'and nothing else');
});

test('a cursed run is named for its multiplier, live and on the payout', () => {
  const game = makeGame(cursedBoard());

  land(game, 3, 0, -170); // ordinary knot opens the run
  land(game, 1, 0, 260); // one off the curse takes it cursed
  assert.equal(game.cursedMult, opened());

  assert.equal(
    drawn(game).comboName,
    comboName(opened()),
    'named while it runs, by the multiplier and not by the knot rung',
  );

  // Step to the lapse rather than past it: a cursed window burns faster, and
  // overshooting it far enough would outlive the banner being asserted on.
  for (let guard = 0; game.chain > 0 && guard < 400; guard++) advance(game, 16);
  assert.equal(game.chain, 0, 'lapsed');

  assert.equal(game.banner.multiplier, `CURSED COMBO ×${opened()}`);
  assert.equal(game.banner.text, comboName(opened()));
  assert.ok(game.banner.cursed);
});

test('the name climbs with the multiplier, not with the knots', () => {
  const game = makeGame(cursedBoard([1, 3]));

  land(game, 3, 0, -170); // open a run
  land(game, 1, 0, 260); // off the curse -> x2
  const atBase = drawn(game).comboName;
  const knotsAtBase = game.chain;

  land(game, 2, 0, 300); // a weight-3 rope off the curse -> x5
  assert.equal(game.cursedMult, opened() + cursedStep(3));
  assert.ok(game.chain > knotsAtBase, 'the knot rung climbed too');

  const atFive = drawn(game).comboName;
  assert.equal(atFive, comboName(opened() + cursedStep(3)), 'the name followed the multiplier');
  assert.notEqual(atFive, atBase);
});

test('the readout is struck every time the multiplier climbs', () => {
  const game = makeGame(cursedBoard([1, 3]));

  land(game, 3, 0, -170); // an ordinary knot — no multiplier yet, nothing to strike
  assert.equal(drawn(game).cursedPop, 0);

  land(game, 1, 0, 260); // off the curse -> x2 opens
  assert.ok(drawn(game).cursedPop > 0.9, 'opening the multiplier strikes it');

  advance(game, 400);
  assert.equal(drawn(game).cursedPop, 0, 'and it settles back');

  land(game, 2, 0, 300); // a weight-3 rope off the curse -> x5
  assert.equal(game.cursedMult, opened() + cursedStep(3));
  assert.ok(drawn(game).cursedPop > 0.9, 'every climb strikes it again');
});

test('an ordinary knot mid-curse does not strike the readout', () => {
  // The jump means "the multiplier moved". A knot taken away from the curse climbs the
  // rung and pays, but the number the jump is about did not change.
  const game = makeGame(cursedBoard());

  land(game, 3, 0, -170);
  land(game, 1, 0, 260); // cursed x2
  advance(game, 400); // let the opening strike settle

  const before = game.chain;
  land(game, 5, 0, -170); // an ordinary rope, nowhere near the curse
  assert.ok(game.chain > before, 'the rung climbed');
  assert.equal(game.cursedMult, opened(), 'the multiplier did not');
  assert.equal(drawn(game).cursedPop, 0, 'so the readout holds still');
});

test('a jump never outlives the run that struck it', () => {
  const game = makeGame(cursedBoard());

  land(game, 3, 0, -170);
  land(game, 1, 0, 260);
  assert.ok(game.cursedPop > 0);

  // End the run mid-jump — a drop that untangles nothing does it. The slot is about to be
  // handed to a different run, and a hop left in flight would land on whatever that one
  // puts there.
  land(game, 8, 0, -5); // shuffles a rope that stays exactly as knotted as it was
  assert.equal(game.chain, 0, 'the run is dead');
  assert.equal(game.cursedPop, 0, 'and it took its jump with it');
});

test('a cursed callout never puts a second x-number on screen', () => {
  // The knot rung keeps escalating what each knot is worth underneath, but while the curse
  // is running it is never *shown* as a multiplier: one x-number that multiplies the pot
  // beside another that only counts knots read as the same kind of quantity.
  const game = makeGame(cursedBoard());

  land(game, 3, 0, -170);
  land(game, 1, 0, 260);

  const state = drawn(game);
  assert.ok(!state.comboName.includes('×'), 'the name is a bare name');

  for (let guard = 0; game.chain > 0 && guard < 400; guard++) advance(game, 16);
  assert.ok(!game.banner.text.includes('×'), 'and so is the payout subhead');
  assert.equal(
    (`${game.banner.multiplier} ${game.banner.text}`.match(/×/g) || []).length,
    1,
    'exactly one multiplier on the callout, and it is the cursed one',
  );
});

// --- heavy ropes pay heavy knots --------------------------------------------------------------

test('a knot hauled off a triple rope is worth three of one off a light rope', () => {
  const heavy = makeGame(ladderBoard([3]));
  const light = makeGame(ladderBoard());

  clear(heavy, 0);
  clear(light, 0);

  assert.equal(heavy.chain, 1, 'weight prices the knot, it does not add rungs');
  assert.equal(light.chain, 1);
  assert.ok(
    Math.abs(heavy.score.comboScore - light.score.comboScore * 3) < 1e-9,
    `${heavy.score.comboScore.toFixed(0)} should be three times ${light.score.comboScore.toFixed(0)}`,
  );
});

test('the knot popup shows what the heavy knot was actually worth', () => {
  const game = makeGame(ladderBoard([2]));
  clear(game, 0);

  const flash = game.flashes.at(-1);
  assert.equal(flash.text, `+${Math.round(COMBO.KNOT_VALUE * 2)}`);
});

// --- running out of moves -------------------------------------------------------------------

/**
 * One knot between two ropes of the given weight, plus a weight-1 rope lying clear in the
 * corner. Either rope in a crossing clears it, so the knot is only unaffordable when
 * *both* ends are — the corner rope is the decoy that used to keep a dead stage "alive".
 */
function knotBoard(weight, moves) {
  return makeGame(
    [
      vertical(0, 400, 200, 8, 20, weight),
      horizontal(1, 340, 260, 7, 20, weight),
      horizontal(2, 1200, 700, 7), // clear of everything, weight 1
    ],
    { moves },
  );
}

test('one move left against a knotted pair of doubles is a loss, not a deadlock', () => {
  // Counting the free corner rope as "the cheapest move" used to read as playable, while
  // onGrab refused both ropes that actually mattered. That is a deadlock, not a reprieve.
  const game = knotBoard(2, 3);

  game.budget.spend(1);
  land(game, 2, 0, -40); // nudge the free rope: resolves nothing, so the stage re-evaluates
  assert.equal(game.budget.totalLeft, 1);

  assert.equal(game.state, 'gameover', 'the knot costs 2 either way and 1 is left');
  assert.ok(game.hud.calls.some(([name]) => name === 'gameover'));
});

test('two moves left against a knotted pair of triples is also a loss', () => {
  const game = knotBoard(3, 4);

  game.budget.spend(1);
  land(game, 2, 0, -40);
  assert.equal(game.budget.totalLeft, 2);

  assert.equal(game.state, 'gameover');
});

test('affording either end of the knot keeps the stage alive', () => {
  const game = knotBoard(2, 4);

  game.budget.spend(1);
  land(game, 2, 0, -40);
  assert.equal(game.budget.totalLeft, 2, 'exactly enough for one of the doubles');

  assert.equal(game.state, 'playing', 'the knot is still payable, so play continues');
});

test('a cheap rope on one end of the knot is enough to stay alive', () => {
  // The flip side: a double knotted against a single is a 1-move problem, not a 2-move one.
  const game = makeGame(
    [
      vertical(0, 400, 200, 8, 20, 3),
      horizontal(1, 340, 260, 7, 20, 1),
      horizontal(2, 1200, 700, 7),
    ],
    { moves: 3 },
  );

  game.budget.spend(1);
  land(game, 2, 0, -40);
  assert.equal(game.budget.totalLeft, 1);

  assert.equal(game.state, 'playing', 'move the cheap end — the knot costs 1, not 3');
});
