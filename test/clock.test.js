import assert from 'node:assert/strict';
import test from 'node:test';

import { CLOCK } from '../src/config.js';
import { slackFor, stageDeadline, thinFor } from '../src/deadline.js';
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
    setCountdown(level) {
      this.countdown = level;
    },
    showBriefing(key, info) {
      this.calls.push(['briefing', { key, ...info }]);
      return true;
    },
    hideBriefing() {},
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

/** The state the renderer is actually handed, which is where the panic wash reads from. */
function drawn(game) {
  let state = null;
  game.renderer = { resize() {}, draw: (s) => (state = s) };
  game.render(0);
  return state;
}

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

test('the buzzer ends the stage with the rope still in hand, not at the drop', () => {
  // The rope being held is not a reason to wait. Deferring to the release leaves the clock
  // reading zero on a board that still answers to the pointer, and the player holding the
  // one thing the readout says they have run out of.
  const game = makeGame({ limit: 10000 });
  const node = game.ropes[0].nodes[0];
  assert.ok(game.onGrab(node.x, node.y, false));

  advance(game, 9900);
  assert.equal(game.state, 'playing', 'still theirs with a tenth of a second left');
  assert.ok(game.grab, 'and still holding');

  advance(game, 200);
  assert.equal(game.state, 'gameover', 'the buzzer ended it where it stood');
  assert.equal(game.grab, null, 'and took the rope out of their hand');
  assert.equal(outcome(game.hud)[1].reason, 'time');
});

test('the gesture the buzzer interrupted is not charged for', () => {
  // It was never completed: no drop, no settle, nothing scored. Spending the move as well
  // would bill the player for the half of a gesture the game itself cut short.
  const game = makeGame({ limit: 10000 });
  const spent = game.budget.totalLeft;

  const node = game.ropes[0].nodes[0];
  assert.ok(game.onGrab(node.x, node.y, false));
  game.ropes[0].translate(0, -170);
  game.score.addDistance(600);
  advance(game, 11000);

  assert.equal(game.budget.totalLeft, spent, 'the move was not taken');
  assert.equal(game.settle, null, 'and no settle was started to score it');
});

test('a lost stage does not sit on the verdict while a callout plays', () => {
  // A callout outlives the drop that earned it by about a second, so one cashed just before
  // the buzzer is still on screen when it goes. Holding the panel back for it means the
  // board sits there red, shaking and reading 0.0 while the only thing the player is
  // waiting to be told is whether the stage is over.
  const game = makeGame({ limit: 10000 });
  // Set with the buzzer already in sight, because a callout only lasts about a second — put
  // one up at the start of the stage and it is long gone by the time the clock runs out.
  advance(game, 9900);
  game.banner = { multiplier: '3 KNOTS', payout: '+900', life: 900, total: 1100 };

  advance(game, 200);

  assert.ok(game.banner, 'sanity: the callout really was still on screen');
  assert.equal(game.state, 'gameover', 'the verdict is not held back');
  assert.equal(game.pending, null, 'and nothing is queued behind it');
  assert.equal(outcome(game.hud)[0], 'gameover');
});

test('a cleared stage still holds the panel back so the callout can land', () => {
  // The other half of the same rule. The winning move is very often the biggest combo of
  // the stage, and slamming the card up over it is exactly when it is never seen.
  const game = makeGame({ limit: 60000 });

  drag(game, 0, 0, -170);
  settleOut(game);
  drag(game, 2, 0, -170); // the second knot, which both solves the board and pays the combo
  settleOut(game);

  assert.ok(game.banner, 'sanity: the clearing combo did call out');
  assert.ok(game.pending, 'the panel is queued rather than shown');
  assert.ok(game.pending.delay > 0, 'behind a real beat');

  flush(game);
  assert.equal(outcome(game.hud)[0], 'cleared');
});

test('a release after the buzzer finds nothing held and does nothing', () => {
  // The pointer-up still arrives — the player has to let go eventually. By then the stage
  // is over and the grab is gone, so it must not run a second ending through #endGesture.
  const game = makeGame({ limit: 10000 });
  const node = game.ropes[0].nodes[0];
  game.onGrab(node.x, node.y, false);
  game.ropes[0].translate(0, -170);
  game.score.addDistance(600);
  advance(game, 11000);

  const endings = game.hud.calls.filter(([kind]) => kind === 'gameover').length;
  game.onRelease();
  settleOut(game);

  assert.equal(game.settle, null, 'the late release started nothing');
  assert.equal(
    game.hud.calls.filter(([kind]) => kind === 'gameover').length,
    endings,
    'and the stage ended exactly once',
  );
});

// --- the endgame, said by the board -------------------------------------------------

/**
 * The panic wash and the shake, which are the clock said in a way you do not have to be
 * looking at the corner to hear. Both are fractions of the *deadline* rather than counts of
 * seconds: nearly out of forty seconds and nearly out of three minutes are the same feeling.
 */

test('the board is calm for the first three fifths of the clock', () => {
  const game = makeGame({ limit: 100000 });

  assert.equal(drawn(game).panic, 0, 'nothing at the start');

  advance(game, 59000);
  assert.equal(drawn(game).panic, 0, 'and nothing at 41% left');
});

test('the red comes on at two fifths left and fills as the clock empties', () => {
  const game = makeGame({ limit: 100000 });

  advance(game, 60000);
  assertNear(drawn(game).panic, 0, 'it opens at exactly zero rather than snapping on');

  // Three quarters rather than half: the ramp eases out, so the wash spends most of its
  // range in the first moments past the threshold and takes the rest of the endgame to
  // creep the last quarter. Crossing into the endgame is meant to be an event.
  advance(game, 20000);
  assertNear(drawn(game).panic, 0.75, 'half the endgame spent, three quarters of the wash');

  advance(game, 19000);
  assertNear(drawn(game).panic, 0.999, 'and all but there at a second to go');
});

test('the shake holds off well inside the wash, and then ramps on its own', () => {
  const game = makeGame({ limit: 100000 });

  advance(game, 80000);
  assert.ok(drawn(game).panic > 0, 'the wash is well under way');
  assert.equal(drawn(game).shake, 0, 'and the board is still still');

  advance(game, 5000);
  assertNear(drawn(game).shake, 0, 'it opens at zero too');

  advance(game, 7500);
  assertNear(drawn(game).shake, 0.75, 'and eases out the same way the wash does');

  advance(game, 7400);
  assert.ok(drawn(game).shake > 0.9, 'wide open by the buzzer');
});

test('neither ever fires on a stage nobody has cleared', () => {
  // An untimed stage has its fraction pinned at 1, so there is no endgame to be in. A board
  // going red on a clock that is not running would be the alarm inventing an emergency.
  const game = makeGame({ limit: null });
  advance(game, 10 * 60 * 1000);

  assert.equal(drawn(game).panic, 0);
  assert.equal(drawn(game).shake, 0);
});

test('the alarm does not outlive the stage it was warning about', () => {
  // The clock's fraction survives the end of a stage — a board lost to it sits at exactly
  // zero — so without a gate the game-over panel comes up over a board still shaking itself
  // apart at full red.
  const game = makeGame({ limit: 5000 });
  advance(game, 4900);
  assert.ok(drawn(game).shake > 0, 'sanity: it was going right up to the buzzer');

  advance(game, 200);
  assert.equal(game.state, 'gameover');
  assert.equal(drawn(game).panic, 0, 'and it stops the moment the stage does');
  assert.equal(drawn(game).shake, 0);
});

test('a stage cleared on the buzzer keeps the alarm through the callout', () => {
  // `ending` is the beat a combo callout gets before the panel covers the board. The stage
  // is decided but the board is still up, and cutting the wash out from under the callout
  // would be a pop on the one frame the player is looking at it.
  const game = makeGame({ limit: 30000 });
  advance(game, 29000);

  drag(game, 0, 0, -170);
  game.pending = { finish: 'solve', reason: 'moves', delay: 500 };
  game.state = 'ending';

  assert.ok(drawn(game).panic > 0.8, 'still red while the callout lands');
  assert.ok(drawn(game).shake > 0);
});

function assertNear(actual, expected, message = '') {
  assert.ok(
    Math.abs(actual - expected) < 0.02,
    `${message} — expected about ${expected}, got ${actual}`,
  );
}

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
  // One run on record is quoted as itself, widened by the thin margin a single sample
  // carries, times this stage's slack. Nothing to approximate.
  const times = {};
  const game = makeGame({ limit: null, times, stage: 5 });

  advance(game, 26000);
  clear(game, 0);
  clear(game, 2);
  assert.equal(outcome(game.hud)[0], 'cleared');

  const took = times['5'][0];
  const next = stageDeadline(5, times);
  const expected = Math.max(CLOCK.FLOOR_MS, took * thinFor(1) * slackFor(5));
  assert.ok(Math.abs(next - expected) < 1, `got ${next} for a ${took}ms clear`);
  assert.ok(next > took, 'and stage 5 is early enough to still be handed a margin');
});

test('past par a stage is still handed a margin on the clear that taught it', () => {
  // One run on record and past par. The old model handed back exactly that run, so the
  // ask was "beat your only clear"; a clear is by definition under the deadline it was
  // played against, so that ask only ever tightened. The resting margin is what remains.
  const stage = CLOCK.PAR_STAGE + 10;
  const times = {};
  const game = makeGame({ limit: null, times, stage });

  advance(game, 26000);
  clear(game, 0);
  clear(game, 2);

  const took = times[String(stage)][0];
  assert.ok(stageDeadline(stage, times) > took, 'a margin past par');
  assert.equal(slackFor(stage), CLOCK.SLACK_END);
});
