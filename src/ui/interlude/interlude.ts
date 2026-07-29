import { formatScore } from '../../scoring.js';
import { define, UiElement } from '../base.ts';
import { UButton } from '../button/button.ts';
import '../icon/icon.ts';
import '../overlay/overlay.ts';
import '../panel/panel.ts';
import css from './interlude.scss?inline';
import template from './interlude.html?raw';

/** What a cleared stage was worth, and what the run is worth now. */
export interface ClearedStage {
  stage: number;
  score: number;
  total: number;
}

export class UInterlude extends UiElement {
  readonly #stage: HTMLElement;
  readonly #score: HTMLElement;
  readonly #total: HTMLElement;
  readonly #timer: HTMLElement;
  readonly #pause: UButton;
  readonly #pauseLabel: HTMLElement;

  constructor() {
    super(template, [css]);
    this.#stage = this.$('[data-el="stage"]');
    this.#score = this.$('[data-el="score"]');
    this.#total = this.$('[data-el="total"]');
    this.#timer = this.$('[data-el="timer"]');
    this.#pause = this.$<UButton>('[data-action="pause"]');
    this.#pauseLabel = this.$('[data-el="pause-label"]');

    this.#pause.addEventListener('click', () => this.emit('pause'));
    this.$('[data-action="play"]').addEventListener('click', () => this.emit('play'));
  }

  /** The card that says you cleared it, and what it paid. Holds, then the next board. */
  showCleared({ stage, score, total }: ClearedStage): void {
    this.#stage.textContent = String(stage);
    this.#score.textContent = formatScore(score);
    this.#total.textContent = formatScore(total);
    this.hidden = false;
  }

  hide(): void {
    this.hidden = true;
  }

  /**
   * The hold, as a level rather than a number: 1 is the card's full beat, 0 is up.
   *
   * The wash behind the text drains with it. Written every frame while the card is up, so it
   * is guarded like everything else here: the same transform written sixty times a second is
   * sixty style recalculations for one picture.
   */
  setCountdown(fraction: number): void {
    const scale = Math.max(0, Math.min(1, fraction)).toFixed(3);
    if (!this.changed('countdown', scale)) return;
    this.#timer.style.transform = `scaleY(${scale})`;
  }

  /**
   * Flips the pause control between pause and resume.
   *
   * The label goes into a span and the tooltip onto the button, never into the button's own
   * text: its content is the two icons, and `textContent =` would delete them — leaving a
   * control that still works, still reads correctly to a screen reader, and is simply
   * invisible from the first time anyone pauses.
   *
   * Which icon shows is the stylesheet's job, keyed off `paused` on this element. That
   * attribute was already being toggled here, so there is no second thing to keep in step.
   */
  setPaused(paused: boolean): void {
    if (!this.changed('paused', paused)) return;
    const label = paused ? 'Resume' : 'Pause';
    this.#pauseLabel.textContent = label;
    this.#pause.setAttribute('title', label);
    this.#pause.held = paused;
    this.toggleAttribute('paused', paused);
  }
}

define('u-interlude', UInterlude);
