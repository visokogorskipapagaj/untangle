import assert from 'node:assert/strict';
import test from 'node:test';

import { INTERLUDE } from '../src/config.js';
import { Game } from '../src/game.js';

/**
 * The sequence between stages: a CLEARED card, a swipe, a countdown, GO, and the board.
 *
 * These drive a real Game against the real generator, because the thing under test is the
 * handover itself — when the next board is built, when the clock is allowed to start, and
 * what the player is allowed to touch while a card is up.
 */

const WIDTH = 1600;
const HEIGHT = 900;

function stubHud() {
  return {
    calls: [],
    countdown: null,
    paused: null,
    hideGameOver() {},
    hideTitle() {},
    showCleared(info) {
      this.cleared = info;
      this.calls.push(['cleared', info.stage]);
    },
    showCountdown(stage, taunt) {
      this.calls.push(['countdown', stage, taunt]);
    },
    setCountdown(text) {
      this.countdown = text;
    },
    setPaused(paused) {
      this.paused = paused;
    },
    hideInterlude() {
      this.calls.push(['hidden']);
    },
    showGameOver(s) {
      this.calls.push(['gameover', s]);
    },
    showMoveDelta() {},
    showBankDelta() {},
    shudder() {},
    setStats() {},
    get anyOverlayOpen() {
      return false;
    },
  };
}

function makeGame() {
  const game = new Game({
    renderer: { resize() {}, draw() {} },
    hud: stubHud(),
    progress: { maxStage: 1, total: 0, best: {}, times: {}, options: {} },
    baseSeed: 7,
    debug: false,
  });
  game.width = WIDTH;
  game.height = HEIGHT;
  game.margin = 30;
  return game;
}

function advance(game, ms, step = 16) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    game.update(Math.min(step, ms - elapsed), 0);
  }
}

/**
 * Runs the sequence out until the board is playable.
 *
 * Waits on the state rather than on the sum of the phase lengths: a phase transition
 * drops whatever fraction of a frame it overshot by, so counting the milliseconds lands a
 * few short and leaves the test one tick inside GO.
 */
function countIn(game) {
  for (let guard = 0; game.state !== 'playing' && guard < 800; guard++) game.update(16, 0);
  assert.equal(game.state, 'playing', 'the countdown should have handed the board over');
}

/** Steps until the sequence leaves `phase`, for the same reason as countIn. */
function untilPhaseEnds(game, phase) {
  assert.equal(game.interlude?.phase, phase, `expected to be in the ${phase} phase`);
  for (let guard = 0; game.interlude?.phase === phase && guard < 800; guard++) {
    game.update(16, 0);
  }
}

const kinds = (hud) => hud.calls.map((call) => call[0]);

// --- entering a stage --------------------------------------------------------------

test('starting a run counts you in rather than dropping you on the board', () => {
  const game = makeGame();
  game.start(1);

  assert.equal(game.state, 'intro');
  assert.deepEqual(game.hud.calls, [['countdown', 1, false]]);
  assert.equal(game.hud.countdown, '3.00', 'and it opens on the full count');
  assert.equal(game.interlude.phase, 'countdown');
});

test('the count runs down, lands on GO, and then hands the board over', () => {
  const game = makeGame();
  game.start(1);

  advance(game, 1000);
  assert.equal(game.hud.countdown, '2.00');
  assert.equal(game.state, 'intro', 'still not playable');

  advance(game, 1500);
  assert.equal(game.hud.countdown, '0.50');

  advance(game, 500);
  assert.equal(game.hud.countdown, 'GO');
  assert.equal(game.state, 'intro', 'GO is a beat of its own, not the handover');

  advance(game, INTERLUDE.GO_MS + 100);
  assert.equal(game.state, 'playing');
  assert.equal(game.interlude, null);
  assert.ok(kinds(game.hud).includes('hidden'), 'and the overlay is taken down');
});

test('nothing on the board can be touched until the count finishes', () => {
  const game = makeGame();
  game.start(1);

  const node = game.ropes[0].nodes[0];
  assert.equal(game.onGrab(node.x, node.y, false), false, 'not during the count');

  countIn(game);
  assert.equal(game.onGrab(node.x, node.y, false), true, 'and immediately after it');
});

test('the stage clock does not start until the board does', () => {
  const game = makeGame();
  // Stage 1 has no record, so it loads untimed; elapsed is the thing being watched here.
  game.start(1);

  advance(game, INTERLUDE.COUNTDOWN_MS + INTERLUDE.GO_MS - 100);
  assert.equal(game.clock.elapsed, 0, 'the count is not the player\'s time');

  advance(game, 2000);
  assert.ok(game.clock.elapsed > 0, 'and it runs once the board is theirs');
});

// --- pausing ------------------------------------------------------------------------

test('PAUSE holds the count, and the same button lets it go', () => {
  const game = makeGame();
  game.start(1);
  advance(game, 1000);

  game.togglePause();
  assert.equal(game.paused, true);
  assert.equal(game.hud.paused, true);

  advance(game, 30000);
  assert.equal(game.hud.countdown, '2.00', 'the count did not move');
  assert.equal(game.state, 'intro', 'and the stage did not start without them');

  game.togglePause();
  assert.equal(game.hud.paused, false);
  countIn(game);
});

test('pause does nothing while a stage is actually being played', () => {
  const game = makeGame();
  game.start(1);
  countIn(game);

  game.togglePause();
  assert.equal(game.paused, false, 'there is no sequence to hold');
});

// --- clearing a stage ---------------------------------------------------------------

test('a cleared stage holds its card, then swipes into the next stage counting in', () => {
  const game = makeGame();
  game.start(4);
  countIn(game);

  game.progress.times = {};
  forceSolve(game);
  assert.equal(game.state, 'cleared');
  assert.deepEqual(game.hud.calls.at(-1), ['cleared', 4]);

  // The card holds for its full beat before anything moves.
  advance(game, INTERLUDE.CLEARED_MS - 100);
  assert.equal(game.stage, 4, 'the next board is not built early');
  assert.deepEqual(game.hud.calls.at(-1), ['cleared', 4]);

  advance(game, 200);
  assert.equal(game.stage, 5, 'the next board is built under the swipe');
  assert.deepEqual(game.hud.calls.at(-1), ['countdown', 5, false]);
  assert.equal(game.interlude.phase, 'swipe');
  assert.equal(game.hud.countdown, '3.00', 'showing the full count while it slides');

  // Counting only starts once the card has arrived — the whole swipe is spent on 3.00.
  untilPhaseEnds(game, 'swipe');
  assert.equal(game.interlude.phase, 'countdown');
  assert.equal(game.hud.countdown, '3.00', 'the count had not started under the swipe');

  advance(game, 1000);
  assert.equal(game.hud.countdown, '2.00');

  countIn(game);
  assert.equal(game.stage, 5);
});

test('a cleared stage is still banked, it is just not read out', () => {
  const game = makeGame();
  game.start(3);
  countIn(game);
  advance(game, 8000);
  forceSolve(game);

  assert.equal(game.progress.maxStage, 3, 'progress is kept');
  assert.ok(game.progress.best['3'] > 0, 'and so is the stage best');
  assert.equal(game.progress.times['3'].length, 1, 'and the clock learned from it');

  // The two numbers the card reads out are the stage's own and the run's so far. On the
  // first stage of a run they are the same figure, which is exactly why the card names it
  // twice rather than making the player infer one from the other.
  assert.equal(game.hud.cleared.stage, 3);
  assert.equal(game.hud.cleared.score, game.progress.best['3']);
  assert.equal(game.hud.cleared.total, game.hud.cleared.score, 'one stage in, the run is it');
});

test('the run total on the card accumulates across stages', () => {
  const game = makeGame();
  game.start(2);
  countIn(game);
  forceSolve(game);
  const first = game.hud.cleared;

  countIn(game); // through the swipe and the next count, into stage 3
  forceSolve(game);
  const second = game.hud.cleared;

  assert.equal(second.stage, 3);
  assert.ok(second.total > first.total, 'the run total climbs');
  assert.ok(
    Math.abs(second.total - (first.score + second.score)) < 1e-9,
    'and it is the sum of the stages behind it, not a repeat of the last one',
  );
});

test('the run can be held between stages too', () => {
  const game = makeGame();
  game.start(2);
  countIn(game);
  forceSolve(game);

  game.togglePause();
  advance(game, 60000);
  assert.equal(game.stage, 2, 'the next stage did not load itself');
  assert.equal(game.state, 'cleared');

  game.togglePause();
  countIn(game);
  assert.equal(game.stage, 3);
});

// --- Rip & Tear -----------------------------------------------------------------------

test('Rip & Tear drops the player straight into stage 30, and says something about it', () => {
  const game = makeGame();
  game.ripAndTear();

  assert.equal(game.stage, INTERLUDE.RIP_AND_TEAR_STAGE);
  assert.deepEqual(game.hud.calls, [['countdown', INTERLUDE.RIP_AND_TEAR_STAGE, true]]);
});

test('the taunt is Rip & Tear\'s alone and does not follow you to stage 31', () => {
  const game = makeGame();
  game.ripAndTear();
  countIn(game);
  forceSolve(game);
  advance(game, INTERLUDE.CLEARED_MS + 50);

  assert.deepEqual(game.hud.calls.at(-1), ['countdown', 31, false]);
});

test('an ordinary start carries no taunt', () => {
  const game = makeGame();
  game.start(1);
  assert.equal(game.hud.calls[0][2], false);
});

// --- retrying -------------------------------------------------------------------------

test('a retry counts you back in on the same stage', () => {
  const game = makeGame();
  game.start(6);
  countIn(game);

  game.retryStage();
  assert.equal(game.stage, 6);
  assert.equal(game.state, 'intro');
  assert.deepEqual(game.hud.calls.at(-1), ['countdown', 6, false]);
});

/**
 * Clears the board outright and runs the stage-ending evaluation.
 *
 * Untangling a generated board move by move is a different test's job; what matters here
 * is that the solve path runs, so the ropes are simply taken off it and the tracker is
 * asked to agree.
 */
function forceSolve(game) {
  for (const rope of game.ropes) rope.removed = true;
  game.tracker.recountAll();
  assert.equal(game.tracker.count, 0, 'the board should read as clear');

  game.score.beginMove();
  game.score.addDistance(600);
  game.score.endMove();
  game.onRelease();
  game.settle = {
    ropeIndex: 0,
    remaining: 0,
    curse: -1,
    weight: 1,
    late: false,
    created: 0,
    expired: false,
  };
  for (let guard = 0; game.settle && guard < 400; guard++) game.update(16, 0);
  for (let guard = 0; game.pending && guard < 400; guard++) game.update(16, 0);
}
