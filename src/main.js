import { Game } from './game.js';
import { Hud } from './hud.js';
import { attachInput } from './input.js';
import { loadProgress } from './progress.js';
import { Renderer } from './render.js';

const params = new URLSearchParams(location.search);
const debug = params.get('debug') === '1';
const seedParam = params.get('seed');
const stageParam = params.get('stage');

// A fixed seed makes a whole run reproducible, which is what `?seed=123&stage=7` is for.
const baseSeed =
  seedParam !== null ? parseInt(seedParam, 10) >>> 0 : (Math.random() * 0xffffffff) >>> 0;

const stageEl = document.getElementById('stage');
const canvas = document.getElementById('canvas');
const renderer = new Renderer(canvas);
const progress = loadProgress();

const hud = new Hud({
  onStart: () => game.start(1),
  onNext: () => game.nextStage(),
  onRetry: () => game.retryStage(),
  onGameOverRetry: () => game.retryAfterGameOver(),
  onRestart: () => game.restart(),
  onOptions: (options) => game.setOptions(options),
  // The hotkey, unlike the button, has to refuse while a dialog is up or a rope is held.
  onHotkeyRetry: () => {
    if (game.canRetry) game.retryStage();
  },
});
hud.setOptions(progress.options);

const game = new Game({ renderer, hud, progress, baseSeed, debug });

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
  console.info(`[untangle] seed=${baseSeed} — replay with ?seed=${baseSeed}&stage=<n>&debug=1`);
}

// Debug handles. Poke at a live stage from the browser console — `__game.chain = 9`,
// `__game.budget.bank = 20`, `__game.start(16)` — and they are what lets a headless
// harness drive the real objects rather than a re-implementation of them.
globalThis.__game = game;
globalThis.__hud = hud;
