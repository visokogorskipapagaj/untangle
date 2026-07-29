import assert from 'node:assert/strict';
import test from 'node:test';

import { BRIEFING, CURSED, INTERLUDE } from '../src/config.js';
import { Game } from '../src/game.js';

/**
 * Getting into a stage and out of one: the CLEARED card, the briefings, and the handover.
 *
 * These drive a real Game against the real generator, because the thing under test is the
 * handover itself — when the next board is built, when the clock is allowed to start, and
 * what the player is allowed to touch while a panel is up.
 */

const WIDTH = 1600;
const HEIGHT = 900;

function stubHud() {
  return {
    calls: [],
    /** How full the hold reads, 1 down to 0 — the bar behind the CLEARED card. */
    countdown: null,
    paused: null,
    briefing: null,
    hideGameOver() {},
    hideTitle() {},
    showCleared(info) {
      this.cleared = info;
      this.calls.push(['cleared', info.stage]);
    },
    setCountdown(level) {
      this.countdown = level;
    },
    setPaused(paused) {
      this.paused = paused;
    },
    hideInterlude() {
      this.calls.push(['hidden']);
    },
    showBriefing(key, info) {
      this.briefing = { key, ...info };
      this.calls.push(['briefing', key, info.stage]);
      return true;
    },
    hideBriefing() {
      this.briefing = null;
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

function makeGame(progress = {}) {
  const game = new Game({
    renderer: { resize() {}, draw() {} },
    hud: stubHud(),
    progress: {
      maxStage: 1,
      total: 0,
      best: {},
      times: {},
      options: {},
      // Every briefing already seen unless a test says otherwise: the flow tests are about
      // the handover, and a panel opening in the middle of one is a different subject.
      briefed: { clock: true, cursed: true },
      ...progress,
    },
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
 * Runs the hold out until the next board is playable.
 *
 * Waits on the state rather than on the length of the hold: the transition drops whatever
 * fraction of a frame it overshot by, so counting the milliseconds lands a tick short.
 */
function playOn(game) {
  for (let guard = 0; game.state !== 'playing' && guard < 800; guard++) game.update(16, 0);
  assert.equal(game.state, 'playing', 'the hold should have handed the board over');
}

const kinds = (hud) => hud.calls.map((call) => call[0]);

/** Where the bar has got to. It is a fraction of the hold, so the last bit is not the point. */
function assertLevel(actual, expected, message) {
  assert.ok(
    Math.abs(actual - expected) < 0.005,
    `${message} — expected the bar at about ${expected}, got ${actual}`,
  );
}

// --- entering a stage --------------------------------------------------------------

test('starting a run drops you straight on the board', () => {
  const game = makeGame();
  game.start(1);

  assert.equal(game.state, 'playing', 'no count, no card — the stage is simply yours');
  assert.equal(game.interlude, null);
  assert.equal(game.briefing, null);
});

test('the board is live from the first frame, and so is the clock', () => {
  const game = makeGame();
  game.start(1);

  const node = game.ropes[0].nodes[0];
  assert.equal(game.onGrab(node.x, node.y, false), true, 'grabbable at once');

  game.onRelease();
  advance(game, 500);
  assert.ok(game.clock.elapsed > 0, 'and timed from the moment it was handed over');
});

// --- briefings ----------------------------------------------------------------------

test('stage 1 opens with the clock briefing, and the board waits behind it', () => {
  const game = makeGame({ briefed: {} });
  game.start(1);

  assert.equal(game.briefing, 'clock');
  assert.equal(game.state, 'intro', 'built, but not yet the player\'s');
  assert.deepEqual(game.hud.calls.at(-1), ['briefing', 'clock', 1]);

  const node = game.ropes[0].nodes[0];
  assert.equal(game.onGrab(node.x, node.y, false), false, 'nothing to touch through it');

  advance(game, 5000);
  assert.equal(game.clock.elapsed, 0, 'reading it is not the player\'s time');
  assert.equal(game.state, 'intro', 'and it does not time itself out');
});

test('the briefing hands the board over, and the clock starts there', () => {
  const game = makeGame({ briefed: {} });
  game.start(1);
  advance(game, 3000);

  game.playStage();

  assert.equal(game.state, 'playing');
  assert.equal(game.briefing, null);
  assert.equal(game.hud.briefing, null, 'and the panel really came down');

  advance(game, 500);
  assert.ok(game.clock.elapsed > 0, 'running from the moment it closed');
  assert.ok(game.clock.elapsed <= 600, 'without back-charging the time spent reading');
});

test('the clock briefing is told the stage deadline, so it can quote it', () => {
  // The panel says how long you have got, and there are two answers: a number, or nothing
  // at all on a stage nobody has ever cleared. The game is the only thing that knows which.
  const untimed = makeGame({ briefed: {} });
  untimed.start(1);
  assert.equal(untimed.hud.briefing.limit, null, 'no record, no deadline to quote');

  const timed = makeGame({ briefed: {}, times: { 1: [20000, 21000, 22000] } });
  timed.start(1);
  assert.ok(timed.hud.briefing.limit > 0, 'and a real one once there is one');
  assert.equal(timed.hud.briefing.limit, timed.clock.limit, 'the same one the stage runs on');
});

test('a briefing is shown once and then never again', () => {
  const game = makeGame({ briefed: {} });
  game.start(1);
  game.playStage();
  assert.equal(game.progress.briefed.clock, true, 'filed the moment it went up');

  game.retryStage();
  assert.equal(game.briefing, null, 'a retry does not re-explain the clock');
  assert.equal(game.state, 'playing');

  game.start(1);
  assert.equal(game.briefing, null, 'and neither does a whole new run');
});

test('the cursed briefing lands on the stage the black rope arrives, not before', () => {
  const game = makeGame({ briefed: { clock: true } });

  game.start(CURSED.FROM - 1);
  assert.equal(game.briefing, null, 'nothing to warn about yet');

  game.start(CURSED.FROM);
  assert.equal(game.briefing, 'cursed');
  assert.deepEqual(game.hud.calls.at(-1), ['briefing', 'cursed', CURSED.FROM]);
  assert.ok(
    game.ropes.some((rope) => rope.cursed),
    'and the rope it is about is on the board behind it',
  );
});

test('clearing into a briefing takes the CLEARED card down with it', () => {
  // Two panels, and only one of them may be up: the card is a live overlay until something
  // hides it, and a briefing opening on top would leave the last stage's score behind it.
  const game = makeGame({ briefed: { clock: true } });
  game.start(CURSED.FROM - 1);
  forceSolve(game);
  assert.equal(game.state, 'cleared');

  advance(game, INTERLUDE.CLEARED_MS + 50);

  assert.equal(game.stage, CURSED.FROM);
  assert.equal(game.briefing, 'cursed');
  assert.equal(game.interlude, null, 'the hold is over');
  assert.ok(kinds(game.hud).includes('hidden'), 'and its card was taken down');
});

test('a briefing with no card behind it hands the board over rather than freezing it', () => {
  // The stage -> card map is config and the cards are markup, and nothing joins them at
  // runtime. If they ever part company the stage must still start.
  const game = makeGame({ briefed: {} });
  game.hud.showBriefing = () => false;

  game.start(1);

  assert.equal(game.state, 'playing');
  assert.equal(game.briefing, null, 'nothing is waiting on a panel that never opened');
});

test('restarting from the settings panel puts the briefings back', () => {
  const game = makeGame({ briefed: { clock: true, cursed: true } });
  game.hud.hideSettings = () => {};

  game.restart();

  assert.equal(game.briefing, 'clock', 'stage 1 explains itself again');
  assert.deepEqual(game.progress.briefed, { clock: true }, 'and the rest are owed again');
});

// --- pausing ------------------------------------------------------------------------

test('PAUSE holds the CLEARED card, and the same button lets it go', () => {
  const game = makeGame();
  game.start(2);
  forceSolve(game);
  advance(game, 1000);

  game.togglePause();
  assert.equal(game.paused, true);
  assert.equal(game.hud.paused, true);

  advance(game, 30000);
  assertLevel(game.hud.countdown, 2 / 3, 'the hold did not move');
  assert.equal(game.stage, 2, 'and the next stage did not load itself');

  game.togglePause();
  assert.equal(game.hud.paused, false);
  playOn(game);
  assert.equal(game.stage, 3);
});

test('pause does nothing while a stage is actually being played', () => {
  const game = makeGame();
  game.start(1);

  game.togglePause();
  assert.equal(game.paused, false, 'there is no card to hold');
});

test('a stage cannot begin already held', () => {
  const game = makeGame();
  game.start(2);
  forceSolve(game);
  game.togglePause();
  assert.equal(game.paused, true);

  game.playStage();

  assert.equal(game.state, 'playing');
  assert.equal(game.paused, false);
  assert.equal(game.hud.paused, false, 'and the button says so');
});

// --- clearing a stage ---------------------------------------------------------------

test('a cleared stage holds its card, then hands over the next board', () => {
  const game = makeGame();
  game.start(4);

  game.progress.times = {};
  forceSolve(game);
  assert.equal(game.state, 'cleared');
  assert.deepEqual(game.hud.calls.at(-1), ['cleared', 4]);

  // The card holds for its full beat before anything moves, and the bar behind it says how
  // long that beat has left rather than leaving the player to guess at it.
  advance(game, INTERLUDE.CLEARED_MS - 100);
  assert.equal(game.stage, 4, 'the next board is not built early');
  assert.equal(game.state, 'cleared', 'and the board is not handed over early either');
  assertLevel(game.hud.countdown, 100 / INTERLUDE.CLEARED_MS, 'the hold drains as it goes');

  advance(game, 200);
  assert.equal(game.stage, 5, 'the next board is built when the hold ends');
  assert.equal(game.state, 'playing', 'and it is playable straight away');
  assert.equal(game.hud.countdown, 0, 'the bar is spent rather than nearly spent');
  assert.ok(kinds(game.hud).includes('hidden'), 'and the card came down');
});

test('the next stage is not charged for the card in front of it', () => {
  const game = makeGame();
  game.start(2);
  forceSolve(game);

  advance(game, INTERLUDE.CLEARED_MS - 100);
  assert.equal(game.clock.elapsed, 0, 'the hold is not the player\'s time');

  playOn(game);
  advance(game, 400);
  assert.ok(game.clock.elapsed > 0, 'and the clock runs once the board is theirs');
  assert.ok(game.clock.elapsed <= 500, 'from zero, not from partway through the hold');
});

// --- playing on early ---------------------------------------------------------------

test('the green button ends the hold at once, and it is the same handover', () => {
  const game = makeGame();
  game.start(4);
  forceSolve(game);
  assert.equal(game.stage, 4, 'the next board does not exist yet');

  game.playStage();

  assert.equal(game.state, 'playing');
  assert.equal(game.stage, 5, 'the next board was built on the way through');
  assert.ok(game.tracker.count > 0, 'and it is a real puzzle, not the solved one');
  assert.equal(game.interlude, null, 'nothing left running behind the board');
  assert.ok(kinds(game.hud).includes('hidden'), 'and the overlay really came down');

  // Not a thinner door: the board is live and the clock is on it, exactly as after the hold.
  const node = game.ropes.find((rope) => !rope.removed).nodes[0];
  assert.equal(game.onGrab(node.x, node.y, false), true);
});

test('cutting the card short keeps everything it was reporting', () => {
  // Safe only because the solve banks before the card ever goes up. If that order ever
  // flips, cutting the card short starts costing the player the stage they just won.
  const game = makeGame();
  game.start(3);
  forceSolve(game);

  const banked = game.progress.best['3'];
  const shown = game.hud.cleared;
  assert.ok(banked > 0, 'sanity: the stage scored something');

  game.playStage();

  assert.equal(game.progress.best['3'], banked, 'the best survives it');
  assert.equal(game.progress.maxStage >= 3, true);
  assert.equal(shown.score, banked, 'and the card had been told the same number');
});

test('the green button does nothing when there is nothing to get past', () => {
  const game = makeGame();
  game.playStage();
  assert.equal(game.state, 'title', 'not a way past the title screen');

  game.start(1);
  game.playStage();
  assert.equal(game.state, 'playing', 'and a no-op mid-stage');
  assert.equal(game.stage, 1, 'it certainly does not skip a stage');
});

test('a cleared stage is still banked, it is just not read out', () => {
  const game = makeGame();
  game.start(3);
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
  forceSolve(game);
  const first = game.hud.cleared;

  playOn(game); // through the hold, into stage 3
  forceSolve(game);
  const second = game.hud.cleared;

  assert.equal(second.stage, 3);
  assert.ok(second.total > first.total, 'the run total climbs');
  assert.ok(
    Math.abs(second.total - (first.score + second.score)) < 1e-9,
    'and it is the sum of the stages behind it, not a repeat of the last one',
  );
});

// --- Rip & Tear -----------------------------------------------------------------------

test('Rip & Tear drops the player straight into stage 30, and says something about it', () => {
  const game = makeGame();
  game.ripAndTear();

  assert.equal(game.stage, INTERLUDE.RIP_AND_TEAR_STAGE);
  assert.deepEqual(game.hud.calls.at(-1), [
    'briefing',
    BRIEFING.RIP_AND_TEAR,
    INTERLUDE.RIP_AND_TEAR_STAGE,
  ]);
  assert.ok(!kinds(game.hud).includes('cleared'), 'and no card in front of it');
});

test('Rip & Tear says it every time — it is the button\'s answer, not a lesson', () => {
  const game = makeGame();
  game.ripAndTear();
  game.playStage();
  assert.equal(
    game.progress.briefed[BRIEFING.RIP_AND_TEAR],
    undefined,
    'and nothing about it is filed away',
  );

  game.ripAndTear();
  assert.equal(game.briefing, BRIEFING.RIP_AND_TEAR);
});

test('the taunt is Rip & Tear\'s alone and does not follow you to stage 31', () => {
  const game = makeGame();
  game.ripAndTear();
  game.playStage();
  forceSolve(game);
  advance(game, INTERLUDE.CLEARED_MS + 50);

  assert.equal(game.stage, 31);
  assert.equal(game.briefing, null);
  assert.equal(game.state, 'playing');
});

// --- retrying -------------------------------------------------------------------------

test('a retry hands the same stage straight back', () => {
  const game = makeGame();
  game.start(6);
  advance(game, 2000);

  game.retryStage();
  assert.equal(game.stage, 6);
  assert.equal(game.state, 'playing');
  assert.equal(game.clock.elapsed, 0, 'on a fresh clock');
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
