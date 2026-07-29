import { STAGE } from './config.js';
import { Game } from './game.js';
import { Hud } from './hud.js';
import { attachInput } from './input.js';
import { Pool } from './pool.js';
import { loadProgress } from './progress.js';
import { Renderer } from './render.js';

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const seedParam = params.get('seed');
const stageParam = params.get('stage');

/**
 * Is this a phone, as opposed to a tablet or a touch laptop?
 *
 * Both halves are needed. A coarse pointer alone catches every tablet and touchscreen
 * laptop, which have the room for a full board; a small screen alone catches a narrow
 * desktop window, and the player who drags their window narrow has not changed device.
 * The screen is measured rather than the window, so rotating the phone or the URL bar
 * sliding away cannot change what kind of device it is halfway through a run.
 *
 * `?phone=1` (or `=0`) forces it, which is how this gets tested without a phone.
 */
function isPhone() {
  const forced = params.get('phone');
  if (forced !== null) return forced === '1';

  const coarse = window.matchMedia?.('(pointer: coarse)')?.matches ?? false;
  const shortest = Math.min(window.screen?.width || 0, window.screen?.height || 0);
  return coarse && shortest > 0 && shortest <= STAGE.PHONE_MAX_EDGE_PX;
}

const phone = isPhone();

// A fixed seed makes a whole run reproducible, which is what `?seed=123&stage=7` is for.
const baseSeed =
  seedParam !== null ? parseInt(seedParam, 10) >>> 0 : (Math.random() * 0xffffffff) >>> 0;

const stageEl = document.getElementById('stage');
const canvas = document.getElementById('canvas');
const renderer = new Renderer(canvas);
const progress = loadProgress();

/**
 * The shared pool. Constructing it hydrates the cached par table from localStorage, so the
 * first board already has one; sync() refreshes it and drains any times stranded by a
 * previous offline session, and is pointedly not awaited — nothing below needs it, and a
 * dead server would otherwise hold up the title screen.
 *
 * `?pool=0` plays off this device's own times alone, which is also what happens whenever
 * the server cannot be reached.
 */
const pool = params.get('pool') === '0' ? null : new Pool();
pool?.sync().catch(() => {});

const hud = new Hud({
  onStart: () => game.start(1),
  onRipAndTear: () => game.ripAndTear(),
  onPause: () => game.togglePause(),
  onSkip: () => game.skipInterlude(),
  onGameOverRetry: () => game.retryAfterGameOver(),
  onRestart: () => game.restart(),
  onOptions: (options) => game.setOptions(options),
  // The in-play restart — the HUD button and the R key — unlike the one on the results
  // panel, has to refuse while a dialog is up or a rope is held.
  onRestartStage: () => {
    if (game.canRetry) game.retryStage();
  },
});
hud.setOptions(progress.options);

const game = new Game({ renderer, hud, progress, pool, baseSeed, debug, phone });

attachInput(canvas, {
  onGrab: (x, y, isTouch) => game.onGrab(x, y, isTouch),
  onMove: (x, y) => game.onMove(x, y),
  onRelease: () => game.onRelease(),
});

function fit() {
  const rect = stageEl.getBoundingClientRect();
  game.resize(Math.max(1, Math.round(rect.width)), Math.max(1, Math.round(rect.height)));
}

if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(fit).observe(stageEl);
} else {
  window.addEventListener('resize', fit);
}
fit();

let last = performance.now();
function frame(now) {
  game.update(now - last, now);
  last = now;
  game.render(now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

if (stageParam !== null) {
  hud.hideTitle();
  game.start(Math.max(1, parseInt(stageParam, 10) || 1));
} else {
  hud.showTitle(progress);
}

if (debug) {
  console.info(
    `[untangle] seed=${baseSeed} phone=${phone} — replay with ?seed=${baseSeed}&stage=<n>&debug=1`,
  );
}

// Debug handles. Poke at a live stage from the browser console — `__game.combo.chain = 9`,
// `__game.budget.bank = 20`, `__game.start(16)` — and they are what lets a headless
// harness drive the real objects rather than a re-implementation of them.
globalThis.__game = game;
globalThis.__hud = hud;
globalThis.__pool = pool;
