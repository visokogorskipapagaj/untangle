import assert from 'node:assert/strict';
import test from 'node:test';

import { Game } from '../src/game.js';

/**
 * Resizing the viewport mid-stage. The board is fitted to the frame it was generated in,
 * so a sequence of resizes that ends where it began leaves the board where it began.
 */

const hud = new Proxy({}, { get: (_, key) => (key === 'anyOverlayOpen' ? false : () => {}) });

function makeGame(width, height) {
  const game = new Game({
    renderer: { resize() {}, draw() {} },
    hud,
    progress: { maxStage: 1, total: 0, best: {}, times: {}, options: {} },
    baseSeed: 3,
    debug: false,
  });
  game.resize(width, height);
  game.loadStage(4);
  return game;
}

const snapshot = (game) => game.ropes.map((rope) => rope.nodes.map((p) => [p.x, p.y]));

function assertClose(a, b, message) {
  for (let r = 0; r < a.length; r++) {
    for (let n = 0; n < a[r].length; n++) {
      assert.ok(Math.abs(a[r][n][0] - b[r][n][0]) < 1e-6, `${message}: rope ${r} node ${n} x`);
      assert.ok(Math.abs(a[r][n][1] - b[r][n][1]) < 1e-6, `${message}: rope ${r} node ${n} y`);
    }
  }
}

test('rotating a phone and rotating it back leaves the board exactly where it was', () => {
  // Scaling by the ratio of consecutive viewports lost a little on every change and never
  // got it back: portrait, landscape, portrait left the board at a fifth of its size.
  const game = makeGame(390, 844);
  const before = snapshot(game);
  const segLen = game.ropes[0].segLen;

  game.resize(844, 390);
  assert.ok(game.ropes[0].segLen < segLen, 'landscape is the smaller fit, so it shrinks');
  game.resize(390, 844);

  assertClose(snapshot(game), before, 'back in portrait');
  assert.ok(Math.abs(game.ropes[0].segLen - segLen) < 1e-6);
});

test('a URL bar collapsing and returning costs nothing', () => {
  const game = makeGame(390, 780);
  const before = snapshot(game);

  for (let i = 0; i < 20; i++) {
    game.resize(390, 844);
    game.resize(390, 780);
  }

  assertClose(snapshot(game), before, 'after twenty collapses');
});

test('narrowing a desktop window and widening it again restores the board', () => {
  const game = makeGame(1600, 900);
  const before = snapshot(game);

  game.resize(800, 900);
  game.resize(1600, 900);

  assertClose(snapshot(game), before, 'back at full width');
});

test('a fresh stage is fitted to the viewport it was generated in', () => {
  const game = makeGame(1600, 900);
  game.resize(800, 450);
  assert.ok(Math.abs(game.fit - 0.5) < 1e-9, 'half the frame in both directions');

  game.loadStage(5);
  assert.equal(game.fit, 1, 'the new board is generated for the viewport as it is now');
  assert.deepEqual(game.frame, { width: 800, height: 450 });
});
