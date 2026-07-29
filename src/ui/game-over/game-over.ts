import { define, UiElement } from '../base.ts';
import '../button/button.ts';
import '../icon/icon.ts';
import '../overlay/overlay.ts';
import '../panel/panel.ts';
import css from './game-over.scss?inline';
import template from './game-over.html?raw';

/** How the run ended, and what was still on the board when it did. */
export interface GameOver {
  stage: number;
  knots: number;
  reason?: 'moves' | 'time';
}

export class UGameOver extends UiElement {
  readonly #stage: HTMLElement;
  readonly #reason: HTMLElement;
  readonly #detail: HTMLElement;

  constructor() {
    super(template, [css]);
    this.#stage = this.$('[data-el="stage"]');
    this.#reason = this.$('[data-el="reason"]');
    this.#detail = this.$('[data-el="detail"]');
    this.$('[data-action="retry"]').addEventListener('click', () => this.emit('retry'));
  }

  /**
   * Two ways to lose, and the panel has to say which — the moves counter and the clock sit
   * at opposite ends of the HUD, and a player who has just had the board taken away from
   * them should not have to work out which of the two ran out.
   */
  show({ stage, knots, reason = 'moves' }: GameOver): void {
    const left = `${knots} knot${knots === 1 ? '' : 's'}`;
    this.#stage.textContent = String(stage);
    this.#reason.textContent = reason === 'time' ? 'Out of time' : 'Out of moves';
    this.#detail.textContent =
      reason === 'time'
        ? `Clock got you. ${left} still sitting there.`
        : `That's the moves gone, and ${left} to show for it.`;
    this.hidden = false;
  }

  hide(): void {
    this.hidden = true;
  }
}

define('u-game-over', UGameOver);
