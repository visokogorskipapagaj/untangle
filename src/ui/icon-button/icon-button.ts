import { define, UiElement } from '../base.ts';
import css from './icon-button.scss?inline';
import template from './icon-button.html?raw';

/**
 * A square, quiet button that sits over the board rather than on a panel.
 *
 * Icon-only by definition, so `label` is not optional here the way it is on `u-button` —
 * it is the only thing a screen reader has to go on, and it lands on the real `<button>`
 * inside for the same reason it does there.
 */
export class UIconButton extends UiElement {
  static readonly observedAttributes = ['label'];

  readonly #button: HTMLButtonElement;

  constructor() {
    super(template, [css]);
    this.#button = this.$<HTMLButtonElement>('button');
  }

  attributeChangedCallback(_name: string, _old: string | null, value: string | null): void {
    if (value === null) this.#button.removeAttribute('aria-label');
    else this.#button.setAttribute('aria-label', value);
  }
}

define('u-icon-button', UIconButton);
