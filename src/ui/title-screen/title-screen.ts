import { formatScore } from '../../scoring.js';
import { define, UiElement } from '../base.ts';
import '../button/button.ts';
import '../overlay/overlay.ts';
import '../panel/panel.ts';
import css from './title-screen.scss?inline';
import template from './title-screen.html?raw';

/** As much of a saved run as the title screen has anything to say about. */
export interface RunProgress {
  maxStage: number;
  total: number;
}

export class UTitleScreen extends UiElement {
  readonly #best: HTMLElement;

  constructor() {
    super(template, [css]);
    this.#best = this.$('[data-el="best"]');
    this.$('[data-action="start"]').addEventListener('click', () => this.emit('start'));
    this.$('[data-action="riptear"]').addEventListener('click', () => this.emit('riptear'));
  }

  show(progress: RunProgress): void {
    // Nothing at all until there is a run worth mentioning — "Best run: stage 1" is not a
    // boast, it is a player who has pressed Start once.
    this.#best.textContent =
      progress.maxStage > 1
        ? `Best run reached stage ${progress.maxStage} with ${formatScore(progress.total)} points`
        : '';
    this.hidden = false;
  }

  hide(): void {
    this.hidden = true;
  }
}

define('u-title-screen', UTitleScreen);
