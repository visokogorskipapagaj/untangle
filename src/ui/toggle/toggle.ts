import { define, UiElement } from '../base.ts';
import css from './toggle.scss?inline';
import template from './toggle.html?raw';

/**
 * A checkbox and the sentence explaining it.
 *
 * `name` is how the settings panel tells one from another when it collects them. The
 * re-dispatched `toggle` event is not ceremony: `change` is `composed: false`, so a native
 * checkbox inside a shadow root fires an event the outside world genuinely never hears.
 */
export class UToggle extends UiElement {
  readonly #input: HTMLInputElement;

  constructor() {
    super(template, [css]);
    this.#input = this.$<HTMLInputElement>('input');
    this.#input.addEventListener('change', () => {
      this.emit('toggle', { name: this.name, checked: this.checked });
    });
  }

  get name(): string {
    return this.getAttribute('name') ?? '';
  }

  get checked(): boolean {
    return this.#input.checked;
  }

  set checked(on: boolean) {
    this.#input.checked = on;
  }
}

define('u-toggle', UToggle);
