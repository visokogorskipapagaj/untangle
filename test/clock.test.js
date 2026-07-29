import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOCK } from '../src/config.js';
import { slackFor, stageDeadline } from '../src/deadline.js';
import { Game } from '../src/game.js';
import { Rope } from '../src/rope.js';
import { TangleTracker } from '../src/tangle.js';

/**
 * The stage clock as the game actually runs it. deadline.test.js covers the model in
 * isolation; everything here is about *when* the clock is read and written — that it is
 * held still behind a dialog, that expiry is judged at the drop rather than at the end of
 * the settle, and that a clear is filed with the time it really took.
 *
 * Built on the same bypass as chain-timing.test.js: gestures translate a rope outright
 * rather than dragging it node by node, so the board is exact.
 */

const WIDTH = 1600;
const HEIGHT = 900;

function stubHud() {
  return {
    calls: [],
    overlayOpen: false,
    hideGameOver() {},
    hideTitle() {},
    showCleared(info) {
      this.calls.push(['cleared', info]);
    },
    showCountdown(stage, taunt) {
      this.calls.push(['countdown', { stage, taunt }]);
    },
    setCountdown(text) {
      this.countdown = text;
    },
    setPaused(paused) {
      this.paused = paused;
    },
    hideInterlude() {},
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
      return this.overlayOpen;
    },
  };
}

function horizontal(id, x, y, count = 8, seg = 20) {
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push({ x: x + i * seg, y });
  return new Rope(id, nodes, seg);
}

function vertical(id, x, y, count = 14, seg = 20) {
  const nodes = [];
  for (let i = 0; i < count; i++) nodes.push({ x, y: y + i * seg });
  return new Rope(id, nodes, seg);
}

/** Two crossings. Pulling both verticals clear solves the stage. */
function board() {
  return [
    vertical(0, 300, 200, 8),
    horizontal(1, 240, 260, 7),
    vertical(2, 700, 200, 8),
    horizontal(3, 640, 260, 7),
  ];
}

function makeGame({ limit = null, times = {}, stage = 5, ideal = 20 } = {}) {
  const hud = stubHud();
  const game = new Game({
    renderer: { resize() {}, draw() {} },
    hud,
    progress: { maxStage: 1, total: 0, best: {}, times, options: {} },
    baseSeed: 1,
    debug: false,
  });

  game.width = WIDTH;
  game.height = HEIGHT;
  game.margin = 30;
  game.stage = stage;
  game.ropes = board();
  game.tracker = new TangleTracker(game.ropes);
  game.score.beginStage(Math.hypot(WIDTH, HEIGHT));
  game.budget.bank = 0;
  game.budget.beginStage(ideal, 0);
  game.tracker.collectPoints(game.knotMarkers);
  game.clock.begin(limit);
  game.state = 'playing';
  return game;
}

function advance(game, ms, step = 16) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    game.update(Math.min(step, ms - elapsed), 0);
  }
}

/** Grab, displace, optionally dawdle with the rope in hand, drop. No settle. */
function drag(game, ropeIndex, dx, dy, holdMs = 0) {
  const rope = game.ropes[ropeIndex];
  const node = rope.nodes[0];
  assert.ok(game.onGrab(node.x, node.y, false), `rope ${ropeIndex} should be grabbable`);
  rope.translate(dx, dy);
  game.score.addDistance(600);
  game.tracker.recount(ropeIndex);
  if (holdMs) advance(game, holdMs);
  game.onRelease();
}

function settleOut(game, step = 16) {
  for (let guard = 0; game.settle && guard < 400; guard++) game.update(step, 0);
}

/**
 * Runs out the beat the game holds a stage-ending combo callout for before the stage
 * actually closes. The clock is deliberately not ticking through it — the stage is over —
 * so it costs the player nothing, but nothing reaches the HUD until it ends.
 */
function flush(game, step = 16) {
  for (let guard = 0; game.pending && guard < 200; guard++) game.update(step, 0);
}

/** Pull a vertical clear of its horizontal: settle, and any end-of-stage beat, included. */
function clear(game, ropeIndex, holdMs = 0) {
  drag(game, ropeIndex, 0, -170, holdMs);
  settleOut(game);
  flush(game);
}

const outcome = (hud) => hud.calls[hud.calls.length - 1];

// --- running the clock ------------------------------------------------------------

test('the clock runs while the stage is played', () => {
  const game = makeGame({ limit: 30000 });
  advance(game, 5000);

  assert.equal(game.clock.elapsed, 5000);
  assert.equal(game.clock.remaining, 25000);
  assert.equal(game.hud.stats.timeLeft, 25000, 'and the HUD is handed what is left');
});

test('a dialog over the board holds the clock still', () => {
  // Opening settings must not cost a run. The player cannot touch a rope through it.
  const game = makeGame({ limit: 30000 });
  advance(game, 3000);

  game.hud.overlayOpen = true;
  advance(game, 60000);
  assert.equal(game.clock.elapsed, 3000, 'nothing accrued behind the dialog');
  assert.equal(game.state, 'playing', 'and the stage was not lost while it was up');

  game.hud.overlayOpen = false;
  advance(game, 2000);
  assert.equal(game.clock.elapsed, 5000, 'and it picks up where it left off');
});

test('an untimed stage is still measured, and never ends on the clock', () => {
  const game = makeGame({ limit: null });
  advance(game, 10 * 60 * 1000);

  assert.equal(game.state, 'playing');
  assert.equal(game.clock.elapsed, 600000, 'the measurement is the point — it times it next time');
  assert.equal(game.hud.stats.timeLeft, Infinity);
});

// --- running out -------------------------------------------------------------------

test('running out of time ends the stage as a loss, and says which clock ran out', () => {
  const game = makeGame({ limit: 5000 });
  advance(game, 6000);

  const [kind, detail] = outcome(game.hud);
  assert.equal(kind, 'gameover');
  assert.equal(detail.reason, 'time');
  assert.equal(game.state, 'gameover');
});

test('running out of moves still reports moves, not time', () => {
  const game = makeGame({ limit: 60000 });
  game.budget.beginStage(1, 0);

  // One move that resolves nothing leaves the board knotted with nothing left to spend.
  drag(game, 1, 0, 5);
  settleOut(game);

  const [kind, detail] = outcome(game.hud);
  assert.equal(kind, 'gameover');
  assert.equal(detail.reason, 'moves');
});

test('the buzzer waits for a rope already dropped', () => {
  // The settle is unscored relaxation the game applies, not the player's time — so a rope
  // released with a tenth of a second to spare has landed, and the clock running out
  // before it finishes resolving must not take that back.
  const game = makeGame({ limit: 30000 });
  clear(game, 0);
  advance(game, 29900 - game.clock.elapsed);

  clear(game, 2); // the winning pull, released with 100ms left and resolving after zero

  assert.ok(game.clock.expired, 'the clock did run out mid-settle');
  assert.equal(outcome(game.hud)[0], 'cleared', 'and the drop still counted');
});

test('holding a rope past the buzzer does not stop the clock', () => {
  // Otherwise standing still with a rope in hand is a pause button, and the last stage of
  // every run is played by grabbing a rope and thinking about it.
  const game = makeGame({ limit: 10000 });

  drag(game, 0, 0, -170, 12000);
  settleOut(game);

  const [kind, detail] = outcome(game.hud);
  assert.equal(kind, 'gameover');
  assert.equal(detail.reason, 'time', 'the drop was made out of time');
});

test('a stage cannot be won by holding a rope until the answer arrives', () => {
  const game = makeGame({ limit: 10000 });

  clear(game, 0);
  // The winning pull, but begun before the buzzer and let go long after it.
  drag(game, 2, 0, -170, 12000);
  settleOut(game);

  assert.equal(game.tracker.count, 0, 'the board really is clear');
  assert.equal(outcome(game.hud)[0], 'gameover', 'and it was cleared out of time');
});

// --- what gets recorded ------------------------------------------------------------

test('a clear is filed with the time it took, and unlocks the next attempt', () => {
  const times = {};
  const game = makeGame({ limit: null, times, stage: 5 });

  advance(game, 24000);
  clear(game, 0);
  clear(game, 2);

  assert.equal(outcome(game.hud)[0], 'cleared');
  assert.equal(times['5'].length, 1, 'the untimed debut is exactly what makes it timeable');
  assert.ok(times['5'][0] >= 24000, 'and it is the real elapsed time, in plain ms');
});

test('a stage lost to the clock is not filed as a completion time', () => {
  // It is not a completion. Filing it would teach the model that the stage takes exactly
  // as long as the deadline it just failed.
  const times = {};
  const game = makeGame({ limit: 5000, times, stage: 5 });
  advance(game, 6000);

  assert.equal(outcome(game.hud)[0], 'gameover');
  assert.deepEqual(times, {});
});

test('a cleared stage names the stage it cleared, and holds no scoreboard', () => {
  const game = makeGame({ limit: 40000, stage: 5 });
  advance(game, 12000);
  clear(game, 0);
  clear(game, 2);

  const [kind, detail] = outcome(game.hud);
  assert.equal(kind, 'cleared');
  assert.equal(detail.stage, 5);
  assert.equal(game.state, 'cleared');
  assert.equal(game.clock.limit, 40000, 'the deadline it was played against still stands');
  assert.ok(game.clock.elapsed >= 12000);
});

test('an untimed clear has no deadline to have been played against', () => {
  const game = makeGame({ limit: null, stage: 5 });
  advance(game, 12000);
  clear(game, 0);
  clear(game, 2);

  assert.equal(game.clock.limit, null);
  assert.equal(outcome(game.hud)[0], 'cleared');
});

// --- loading a stage ---------------------------------------------------------------

test('loading a stage sets the deadline from the record and starts the clock over', () => {
  const game = makeGame({ limit: 30000 });
  advance(game, 9000);

  // A well-established record, so the deadline is the trimmed mean times the slack.
  game.progress.times['3'] = Array.from({ length: 12 }, () => 40000);
  game.loadStage(3);

  assert.equal(game.clock.elapsed, 0, 'the previous stage does not carry over');
  assert.ok(game.clock.timed, 'stage 3 has a record, so it is timed');
  assert.equal(game.state, 'intro', 'and it waits behind the countdown');
});

test('a stage with no record loads untimed', () => {
  const game = makeGame({ limit: 30000 });
  game.loadStage(3);

  assert.equal(game.clock.timed, false);
  assert.equal(game.clock.limit, null);
});

test('a progress record from before the clock existed needs no migration', () => {
  const game = new Game({
    renderer: { resize() {}, draw() {} },
    hud: stubHud(),
    progress: { maxStage: 1, total: 0, best: {}, options: {} },
    baseSeed: 1,
    debug: false,
  });

  assert.deepEqual(game.progress.times, {}, 'an absent history is a new player\'s history');
});

// --- the shape of the ladder -------------------------------------------------------

test('the clock a stage is given is the one its own clear earned it', () => {
  // The whole loop, end to end and through the real Game: an untimed debut is played, the
  // time it took is filed, and that time is what the next attempt is measured against.
  //
  // With exactly one sample on record the two halves of the blend agree — the stage's own
  // mean and the general pace are both that clear — so the deadline comes out as the time
  // it took times this stage's slack, with nothing to approximate.
  const times = {};
  const game = makeGame({ limit: null, times, stage: 5 });

  advance(game, 26000);
  clear(game, 0);
  clear(game, 2);
  assert.equal(outcome(game.hud)[0], 'cleared');

  const took = times['5'][0];
  const next = stageDeadline(5, times);
  assert.ok(Math.abs(next - took * slackFor(5)) < 1, `got ${next} for a ${took}ms clear`);
  assert.ok(next > took, 'and stage 5 is early enough to still be handed a margin');
});

test('past par a stage is handed exactly the clear that taught it, and no margin', () => {
  // One run on record and past par, so there is no margin to add and nothing slower to
  // strike off: the deadline is that run. Beating it again is the whole ask.
  const stage = CLOCK.PAR_STAGE + 10;
  const times = {};
  const game = makeGame({ limit: null, times, stage });

  advance(game, 26000);
  clear(game, 0);
  clear(game, 2);

  const took = times[String(stage)][0];
  assert.equal(stageDeadline(stage, times), took, 'no margin past par');
  assert.equal(slackFor(stage), 1);
});
