import { MOVES } from './config.js';

/**
 * The move economy: a per-stage budget plus a bank that persists across stages.
 *
 * Moves count *down*. A stage grants `ideal + bonus`; spending past that draws on the
 * bank. Solve with moves to spare and the remainder banks; solve having overdrawn and
 * the bank pays the difference. Run both dry without solving and the stage is lost.
 *
 * The bank is a cushion rather than savings, so it is capped — see MOVES.BANK_MAX. The cap
 * lives on the property itself rather than in the methods that write it, so there is no
 * route that can miss it: a cap some paths ignored would be one that quietly claws the
 * moves back at the next settle, which is worse than either honouring them or refusing
 * them at the point they were earned.
 */
export class MoveBudget {
  #bank = MOVES.STARTING_BANK;

  constructor() {
    this.beginStage(1, 0);
  }

  /**
   * Never negative, never above the cap, however and by whom it is written.
   *
   * The cap is on what the bank can still pay out, not on the gross figure: an overdraft
   * in progress is already spoken for, so a bank of six with two overdrawn has room for
   * two more. Capping the gross number threw a detonation's reward away and lit the box
   * up as full while it read four.
   */
  get bank() {
    return this.#bank;
  }

  set bank(value) {
    this.#bank = Math.max(0, Math.min(MOVES.BANK_MAX + this.overdraft, value));
  }

  beginStage(ideal, bonus) {
    this.ideal = ideal;
    this.bonus = bonus;
    this.budget = ideal + bonus;
    this.used = 0;
    // A stage abandoned mid-overdraft forgives the overdraft, so anything that was
    // banked against it comes back under the plain cap.
    this.bank = this.#bank;
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

  /**
   * Moves earned mid-stage, e.g. by landing a full chain. Straight into the bank, and
   * wasted if it is already full — the same bargain as picking up ammo at full capacity,
   * and the reason to spend down rather than sit on it.
   */
  grant(moves = 1) {
    this.bank += moves;
  }

  /** True while spare moves are being thrown away, which the HUD says out loud. */
  get bankFull() {
    return this.bankLeft >= MOVES.BANK_MAX;
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
   * overdrew) is deducted. Returns the signed carry — what the stage was worth, not what
   * the bank could take of it, so a full bank is visible as a carry that went nowhere.
   */
  settleStage() {
    const carried = this.budget - this.used;
    this.bank += carried;
    return carried;
  }
}
