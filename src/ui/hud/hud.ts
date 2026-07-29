import { CLOCK, MOVES } from '../../config.js';
import { formatClock } from '../../deadline.js';
import { formatScore } from '../../scoring.js';
import { define, UiElement } from '../base.ts';
import '../icon/icon.ts';
import '../icon-button/icon-button.ts';
import { UStat } from '../stat/stat.ts';
import css from './hud.scss?inline';
import template from './hud.html?raw';

/** What the game hands the strip every frame. */
export interface HudStats {
  stage: number;
  knots: number;
  movesLeft: number;
  bank: number;
  drawingFromBank?: boolean;
  bankFull?: boolean;
  timeLeft: number;
  score: number;
}

/**
 * The readouts across the top of the board.
 *
 * Written sixty times a second and almost always with the same numbers, so every write in
 * here goes through `changed()` — that guard is the difference between a HUD and a stream
 * of style recalculations.
 */
export class UHud extends UiElement {
  readonly #stats: Record<string, UStat> = {};

  constructor() {
    super(template, [css]);

    for (const stat of this.all<UStat>('u-stat')) {
      this.#stats[stat.dataset.stat ?? ''] = stat;
    }

    // Same gated handler as the hotkey: rerolling the stage costs the player their progress
    // on it, so it has to refuse mid-drag rather than reroll the board out from under a
    // rope that is currently in hand. The gate lives in main.js; this only reports the ask.
    this.$('[data-action="restart-stage"]').addEventListener('click', () => {
      this.emit('restart-stage');
    });
    this.$('[data-action="settings"]').addEventListener('click', () => this.emit('settings'));
  }

  /** Writes only what changed — the HUD updates every frame, the DOM should not. */
  setStats({
    stage,
    knots,
    movesLeft,
    bank,
    drawingFromBank,
    bankFull,
    timeLeft,
    score,
  }: HudStats): void {
    this.#stats.stage.value = String(stage);
    // Infinity formats as the infinity sign, which is how an untimed stage reads.
    this.#stats.time.value = formatClock(timeLeft);
    this.#stats.knots.value = String(knots);
    this.#stats.movesLeft.value = String(movesLeft);
    this.#stats.bank.value = String(bank);
    this.#stats.score.value = formatScore(score);

    this.#stats.knots.setState(knots === 0 ? 'clear' : '');

    // Three states, and only one at a time — which is also what stops the critical pulse
    // restarting on every frame.
    this.#stats.time.setState(
      !Number.isFinite(timeLeft)
        ? 'untimed'
        : timeLeft <= CLOCK.CRITICAL_MS
          ? 'critical'
          : timeLeft <= CLOCK.WARN_MS
            ? 'low'
            : '',
    );

    this.#stats.movesLeft.setState(
      movesLeft === 0 ? 'empty' : movesLeft <= MOVES.LOW_WARNING ? 'low' : '',
    );

    // Burning is lit while the next move will come out of savings — the player needs to see
    // the cost before committing to the move, not after paying it. Full means whatever this
    // stage leaves over is lost rather than carried, which is a nudge to spend rather than a
    // problem: burning wins outright, since that one costs the player a run.
    this.#stats.bank.setState(drawingFromBank ? 'burning' : bankFull ? 'full' : '');
  }

  /** Red "-3" beside the move counter when a drag costs more than one move. */
  showMoveDelta(amount: number): void {
    this.#stats.movesLeft.showDelta(`${amount}`);
  }

  /** Green "+1" beside the bank when moves are earned. */
  showBankDelta(amount: number): void {
    this.#stats.bank.showDelta(`+${amount}`);
  }
}

define('u-hud', UHud);
