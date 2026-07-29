import { define, UiElement } from '../base.ts';
import '../button/button.ts';
import '../icon/icon.ts';
import '../overlay/overlay.ts';
import '../panel/panel.ts';
import { UToggle } from '../toggle/toggle.ts';
import css from './settings.scss?inline';
import template from './settings.html?raw';

/** The two things a player can change about how a board is drawn. */
export interface GameOptions {
  distinct: boolean;
  markers: boolean;
}

export class USettings extends UiElement {
  readonly #toggles: Record<string, UToggle> = {};

  constructor() {
    super(template, [css]);

    for (const toggle of this.all<UToggle>('u-toggle')) {
      this.#toggles[toggle.name] = toggle;
      // Collected here rather than let out one at a time: the game sets options as a set,
      // and a caller that has to remember which of the two just moved is a caller that will
      // eventually forget.
      toggle.addEventListener('toggle', () => this.emit('options', this.options));
    }

    this.$('[data-action="restart"]').addEventListener('click', () => this.emit('restart'));
    this.$('[data-action="close"]').addEventListener('click', () => this.hide());
  }

  get options(): GameOptions {
    return {
      distinct: this.#toggles.distinct.checked,
      markers: this.#toggles.markers.checked,
    };
  }

  setOptions(options: Partial<GameOptions>): void {
    this.#toggles.distinct.checked = !!options.distinct;
    this.#toggles.markers.checked = !!options.markers;
  }

  show(): void {
    this.hidden = false;
  }

  hide(): void {
    this.hidden = true;
  }

  get open(): boolean {
    return !this.hidden;
  }
}

define('u-settings', USettings);
