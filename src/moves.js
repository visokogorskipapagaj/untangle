import { MOVES } from './config.js';

/**
 * The move economy: a per-stage budget plus a bank that persists across stages.
 *
 * Moves count *down*. A stage grants `ideal + bonus`; spending past that draws on the
 * bank. Solve with moves to spare and the remainder banks; solve having overdrawn and
 * the bank pays the difference. Run both dry without solving and the stage is lost.
 */
export class MoveBudget {
  constructor() {
    this.bank = MOVES.STARTING_BANK;
    this.beginStage(1, 0);
  }

  beginStage(ideal, bonus) {
    this.ideal = ideal;
    this.bonus = bonus;
    this.budget = ideal + bonus;
    this.used = 0;
  }

  /** A fresh run starts with a small cushion so stage 1 is not a knife-edge. */
  resetRun() {
    this.bank = MOVES.STARTING_BANK;
  }

  /**
   * The cost of a game over: stage progress survives, savings do not. Deliberately
   * harsher than a fresh run — failing has to mean something.
   */
  clearBank() {
    this.bank = 0;
  }

  /** Heavy ropes cost more than one move to drag. */
  spend(cost = 1) {
    this.used += cost;
  }

  /** Moves earned mid-stage, e.g. by landing a full chain. Straight into the bank. */
  grant(moves = 1) {
    this.bank += moves;
  }

  /** Moves left in this stage's own grant, before the bank is touched. */
  get stageLeft() {
    return Math.max(0, this.budget - this.used);
  }

  /** How far past the stage grant the player has already gone. */
  get overdraft() {
    return Math.max(0, this.used - this.budget);
  }

  /** Bank still available after covering any overdraft. */
  get bankLeft() {
    return Math.max(0, this.bank - this.overdraft);
  }

  get totalLeft() {
    return this.stageLeft + this.bankLeft;
  }

  get exhausted() {
    return this.totalLeft <= 0;
  }

  /**
   * Closes out a solved stage. A positive balance banks; a negative one (the player
   * overdrew) is deducted. Returns the signed carry for the results panel.
   */
  settleStage() {
    const carried = this.budget - this.used;
    this.bank = Math.max(0, this.bank + carried);
    return carried;
  }
}
