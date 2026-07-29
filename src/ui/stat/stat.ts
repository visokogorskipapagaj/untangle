import { define, UiElement } from '../base.ts';
import css from './stat.scss?inline';
import template from './stat.html?raw';

/**
 * One labelled readout in the HUD.
 *
 * `variant` says which readout it is, and the sheet keys every colour off that — so a stat
 * knows how to look worried without the HUD having to tell it. `state` is the one thing the
 * HUD does say, and it is deliberately a single value rather than a set of flags: a readout
 * cannot be both low and empty, and burning outranks full, so the state is resolved before
 * it gets here rather than fought over in the stylesheet.
 */
export class UStat extends UiElement {
  static readonly observedAttributes = ['label', 'value'];

  readonly #label: HTMLElement;
  readonly #value: HTMLElement;
  readonly #delta: HTMLElement;

  constructor() {
    super(template, [css]);
    this.#label = this.$('.label');
    this.#value = this.$('.value');
    this.#delta = this.$('.delta');
  }

  /**
   * `value` in the markup is the resting readout — what the stat says before a stage has
   * loaded anything into it. Writing the property afterwards is what the HUD does, and it
   * goes to the text rather than back to the attribute: the markup states where a stat
   * starts, not where it currently is.
   */
  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'label') this.#label.textContent = value ?? '';
    else this.value = value ?? '';
  }

  /** The number. Written every frame by the HUD, so it is guarded like everything else. */
  set value(text: string) {
    if (this.changed('value', text)) this.#value.textContent = text;
  }

  get value(): string {
    return this.#value.textContent ?? '';
  }

  /** '' for the resting state; see the sheet for what each variant recognises. */
  setState(state: string): void {
    if (!this.changed('state', state)) return;
    if (state) this.setAttribute('state', state);
    else this.removeAttribute('state');
  }

  /** The "-3" or "+1" that slides past the counter when it moves by more than one. */
  showDelta(text: string): void {
    this.#delta.textContent = text;
    this.replay(this.#delta, 'is-firing');
  }
}

define('u-stat', UStat);
