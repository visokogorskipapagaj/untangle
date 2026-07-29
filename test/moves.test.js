import assert from 'node:assert/strict';
import test from 'node:test';

import { MOVES } from '../src/config.js';
import { MoveBudget } from '../src/moves.js';

test('a run starts with the cushion bank', () => {
  const budget = new MoveBudget();
  assert.equal(budget.bank, MOVES.STARTING_BANK);
});

test('the worked example: ideal 5 + bonus 2, solved in 6, carries 1', () => {
  const budget = new MoveBudget();
  budget.resetRun();
  budget.beginStage(5, 2);

  assert.equal(budget.budget, 7);
  for (let i = 0; i < 6; i++) budget.spend();

  assert.equal(budget.stageLeft, 1);
  assert.equal(budget.overdraft, 0);

  const carried = budget.settleStage();
  assert.equal(carried, 1);
  assert.equal(budget.bank, MOVES.STARTING_BANK + 1);
});

test('spending past the grant draws on the bank rather than ending the stage', () => {
  const budget = new MoveBudget();
  budget.bank = 3;
  budget.beginStage(2, 0);

  for (let i = 0; i < 4; i++) budget.spend();

  assert.equal(budget.stageLeft, 0);
  assert.equal(budget.overdraft, 2);
  assert.equal(budget.bankLeft, 1);
  assert.equal(budget.totalLeft, 1);
  assert.equal(budget.exhausted, false);
});

test('exhausted only once the grant and the bank are both gone', () => {
  const budget = new MoveBudget();
  budget.bank = 1;
  budget.beginStage(2, 0);

  budget.spend();
  budget.spend();
  assert.equal(budget.exhausted, false, 'grant spent, bank still holds one');

  budget.spend();
  assert.equal(budget.totalLeft, 0);
  assert.equal(budget.exhausted, true);
});

test('solving after an overdraft deducts it from the bank', () => {
  const budget = new MoveBudget();
  budget.bank = 5;
  budget.beginStage(3, 1); // budget 4

  for (let i = 0; i < 6; i++) budget.spend();
  const carried = budget.settleStage();

  assert.equal(carried, -2);
  assert.equal(budget.bank, 3);
});

test('the bank never goes negative', () => {
  const budget = new MoveBudget();
  budget.bank = 1;
  budget.beginStage(1, 0);

  for (let i = 0; i < 9; i++) budget.spend();
  budget.settleStage();

  assert.equal(budget.bank, 0);
});

test('leftover moves compound across stages', () => {
  const budget = new MoveBudget();
  budget.bank = 0;

  budget.beginStage(4, 1); // 5
  budget.spend();
  budget.spend();
  budget.settleStage();
  assert.equal(budget.bank, 3);

  budget.beginStage(3, 0); // 3
  budget.spend();
  budget.settleStage();
  assert.equal(budget.bank, 5);
});

test('the bank stops compounding at the cap', () => {
  // Left uncapped this is the whole problem: a clean player banks a few spare moves every
  // stage, and by the teens carries more spare moves than any one stage costs.
  const budget = new MoveBudget();
  budget.bank = 0;

  for (let stage = 0; stage < 12; stage++) {
    budget.beginStage(5, 0);
    budget.spend();
    budget.spend();
    budget.settleStage(); // +3 a stage, twelve times over
  }
  assert.equal(budget.bank, MOVES.BANK_MAX);
});

test('the carry reports what the stage was worth, not what the bank could take', () => {
  // The bank is full, so this carry goes nowhere — but it is still what the stage earned,
  // and the readout would be lying if it said zero.
  const budget = new MoveBudget();
  budget.bank = MOVES.BANK_MAX;
  budget.beginStage(5, 0);
  budget.spend();

  assert.equal(budget.settleStage(), 4, 'four moves spare');
  assert.equal(budget.bank, MOVES.BANK_MAX, 'and nowhere to put them');
});

test('a move earned at a full bank is lost, not deferred', () => {
  // Deferring it would mean the reward reappearing a stage later out of nowhere, or the
  // next settle silently clawing it back. Neither reads as a rule.
  const budget = new MoveBudget();
  budget.bank = MOVES.BANK_MAX;

  budget.grant(1);
  assert.equal(budget.bank, MOVES.BANK_MAX);
  assert.equal(budget.bankFull, true);

  budget.beginStage(4, 0);
  for (let i = 0; i < 4; i++) budget.spend();
  budget.settleStage();
  assert.equal(budget.bank, MOVES.BANK_MAX, 'and it does not come back later');
});

test('bankFull tracks the cap, and the cap cannot be written around', () => {
  const budget = new MoveBudget();
  budget.bank = 0;
  assert.equal(budget.bankFull, false);

  budget.bank = 999;
  assert.equal(budget.bank, MOVES.BANK_MAX, 'assignment is clamped like everything else');
  assert.equal(budget.bankFull, true);

  budget.bank = -5;
  assert.equal(budget.bank, 0);
});

test('the starting cushion fits inside the cap', () => {
  // A run that began over its own ceiling would lose moves on the first settle for no
  // reason the player could see.
  assert.ok(MOVES.STARTING_BANK <= MOVES.BANK_MAX);
});

test('game over clears the bank, a fresh run restores the cushion', () => {
  const budget = new MoveBudget();
  budget.bank = 9;

  budget.clearBank();
  assert.equal(budget.bank, 0);

  budget.resetRun();
  assert.equal(budget.bank, MOVES.STARTING_BANK);
});
