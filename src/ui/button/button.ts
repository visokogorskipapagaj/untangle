import { define, UiElement } from '../base.ts';
import css from './button.scss?inline';
import template from './button.html?raw';

/**
 * A button on a panel.
 *
 * `variant` picks the treatment — primary for the way on, danger for Rip & Tear, nothing
 * for the rest. `held` marks a control that is currently doing something; see the sheet.
 *
 * `label` is for the icon-only case and lands as `aria-label` on the real `<button>` inside
 * rather than on the host, because a host element with no role is not what a screen reader
 * reads. `title` needs no forwarding: the host is an ordinary element, so the browser's own
 * tooltip works on it as it stands.
 */
export class UButton extends UiElement {
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

  /** Whether this control is currently holding something — the amber breathing state. */
  get held(): boolean {
    return this.hasAttribute('held');
  }

  set held(on: boolean) {
    this.toggleAttribute('held', on);
  }
}

define('u-button', UButton);
