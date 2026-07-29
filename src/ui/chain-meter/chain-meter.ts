import { COMBO } from '../../config.js';
import { define, UiElement } from '../base.ts';
import css from './chain-meter.scss?inline';
import template from './chain-meter.html?raw';

/** Fraction of the window left at which the meter goes red and buzzes. */
const CRITICAL = 0.15;

/** The rung at which a chain — or a cursed multiplier — is deep enough to run hot. */
const HOT = 7;

export class UChainMeter extends UiElement {
  readonly #fill: HTMLElement;

  constructor() {
    super(template, [css]);
    this.#fill = this.$('i');
  }

  /**
   * Drains as the chain window runs out. Written every frame, but only while a chain is
   * live — the bar is hidden the rest of the time, so there is no idle churn.
   */
  update(chain = 0, fraction = 0, cursedMult = 0): void {
    const cursed = cursedMult >= COMBO.CURSED_BASE;

    // Live from the *priming* drop, not from x2. The clock starts there, and a running
    // deadline the player cannot see is the one thing this bar exists to prevent — that is
    // a separate question from whether there is a rung worth shouting about yet.
    const live = chain >= 1 || cursed;
    if (this.changed('live', live)) {
      this.toggleAttribute('live', live);
      // Drop the alarm states on the way out, or the buzz and blink animations keep running
      // on a bar nobody can see.
      if (!live) {
        for (const state of ['critical', 'hot', 'cursed', 'priming']) {
          this.removeAttribute(state);
        }
        this.forget('critical', 'hot', 'cursed', 'priming');
      }
    }
    if (!live) return;

    const left = Math.max(0, Math.min(1, fraction));

    const hot = (cursed ? cursedMult : chain) >= HOT;
    if (this.changed('hot', hot)) this.toggleAttribute('hot', hot);

    // Still priming: the starter is half done and the clock is running, but no rung has been
    // earned. Dimmer and thinner, so it reads as a countdown rather than a stake.
    const priming = !cursed && chain < 2;
    if (this.changed('priming', priming)) this.toggleAttribute('priming', priming);

    // A CURSED COMBO burns the window at double rate, so the meter has to stop looking like
    // the same meter: it doubles in height and blinks.
    if (this.changed('cursed', cursed)) this.toggleAttribute('cursed', cursed);

    const critical = left <= CRITICAL;
    if (this.changed('critical', critical)) this.toggleAttribute('critical', critical);

    const scale = left.toFixed(3);
    if (this.changed('scale', scale)) this.#fill.style.transform = `scaleX(${scale})`;
  }
}

define('u-chain-meter', UChainMeter);
