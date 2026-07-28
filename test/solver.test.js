import assert from 'node:assert/strict';
import test from 'node:test';

import { MOVES } from '../src/config.js';
import { minimumVertexCover, moveBudgetFor } from '../src/solver.js';

test('minimumVertexCover: no edges needs no moves', () => {
  assert.equal(minimumVertexCover(0, []), 0);
  assert.equal(minimumVertexCover(5, []), 0);
});

test('minimumVertexCover: a single crossing costs one rope', () => {
  assert.equal(minimumVertexCover(2, [[0, 1]]), 1);
});

test('minimumVertexCover: a star is covered by its centre alone', () => {
  // One rope crossing four others: move that one rope and the board is clear.
  assert.equal(
    minimumVertexCover(5, [
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
    ]),
    1,
  );
});

test('minimumVertexCover: a path of three needs one, a triangle needs two', () => {
  assert.equal(
    minimumVertexCover(3, [
      [0, 1],
      [1, 2],
    ]),
    1,
  );
  assert.equal(
    minimumVertexCover(3, [
      [0, 1],
      [1, 2],
      [0, 2],
    ]),
    2,
  );
});

test('minimumVertexCover: disjoint crossings each cost a move', () => {
  assert.equal(
    minimumVertexCover(4, [
      [0, 1],
      [2, 3],
    ]),
    2,
  );
});

test('minimumVertexCover: K4 needs three', () => {
  const k4 = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ];
  assert.equal(minimumVertexCover(4, k4), 3);
});

test('minimumVertexCover: exact on a 14-rope worst case', () => {
  // Complete graph on 14 vertices — every rope crosses every other. The cover is n-1,
  // and this is the largest search the game can ever ask for.
  const edges = [];
  for (let i = 0; i < 14; i++) for (let j = i + 1; j < 14; j++) edges.push([i, j]);
  assert.equal(minimumVertexCover(14, edges), 13);
});

test('minimumVertexCover: ignores self-loops', () => {
  assert.equal(
    minimumVertexCover(3, [
      [0, 0],
      [1, 2],
    ]),
    1,
  );
});

test('moveBudgetFor: widens the cover by the slack factor', () => {
  const triangle = [
    [0, 1],
    [1, 2],
    [0, 2],
  ];
  const budget = moveBudgetFor(3, triangle, 3);

  assert.equal(budget.cover, 2);
  assert.equal(budget.ideal, Math.ceil(2 * MOVES.SLACK));
  assert.equal(budget.budget, budget.ideal + budget.bonus);
});

test('moveBudgetFor: the crossing bonus follows its configured rate', () => {
  const budget = moveBudgetFor(4, [[0, 1], [2, 3]], 8);
  const expected =
    MOVES.CROSSINGS_PER_BONUS > 0 ? Math.floor(8 / MOVES.CROSSINGS_PER_BONUS) : 0;

  assert.equal(budget.bonus, expected);
  assert.equal(budget.budget, budget.ideal + expected);
});

test('moveBudgetFor: a disabled bonus never divides by zero', () => {
  const budget = moveBudgetFor(4, [[0, 1]], 999);
  assert.ok(Number.isFinite(budget.bonus));
  assert.ok(Number.isFinite(budget.budget));
});

test('moveBudgetFor: a solved board still grants at least one move', () => {
  const budget = moveBudgetFor(3, [], 0);
  assert.equal(budget.cover, 0);
  assert.equal(budget.ideal, 1);
});
