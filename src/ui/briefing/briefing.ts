import { formatClock } from '../../deadline.js';
import { define, UiElement } from '../base.ts';
import '../button/button.ts';
import '../icon/icon.ts';
import '../overlay/overlay.ts';
import '../panel/panel.ts';
import css from './briefing.scss?inline';
import template from './briefing.html?raw';

/** What a briefing needs to know about the stage it is announcing. */
export interface BriefingContext {
  stage: number;
  /** The deadline in ms, or null for a stage nobody in the pool has ever cleared. */
  limit?: number | null;
}

export class UBriefing extends UiElement {
  readonly #stage: HTMLElement;
  readonly #clockLimit: HTMLElement;
  readonly #clockTimed: HTMLElement;
  readonly #clockUntimed: HTMLElement;

  /**
   * Keyed by BRIEFING's card names, which is the whole mapping from config to markup — a key
   * with no card here simply never opens, rather than throwing mid-stage-load.
   */
  readonly #cards: Record<string, HTMLElement> = {};

  constructor() {
    super(template, [css]);
    this.#stage = this.$('[data-el="stage"]');
    this.#clockLimit = this.$('[data-el="clock-limit"]');
    this.#clockTimed = this.$('[data-el="clock-timed"]');
    this.#clockUntimed = this.$('[data-el="clock-untimed"]');

    for (const card of this.all('[data-brief]')) {
      this.#cards[card.dataset.brief ?? ''] = card;
    }

    this.$('[data-action="play"]').addEventListener('click', () => this.emit('play'));
  }

  /** Every card this panel knows how to open. The other half of the join with config.js. */
  get cards(): string[] {
    return Object.keys(this.#cards);
  }

  /**
   * A briefing: the panel that explains a mechanic on the stage it arrives, once.
   *
   * `limit` decides which of the clock card's two answers is up, and there genuinely are two
   * — announcing a time limit on an untimed board would be a lie, and a briefing that lies
   * about the clock is worse than no briefing.
   *
   * Those fields are written whichever card is opening. They live inside the clock card, so
   * writing them while the cursed one is up puts text into something nobody can see, which
   * is cheaper than a branch that has to be kept in step with the markup.
   *
   * Returns false for a card this panel does not have, so an unknown key is a briefing that
   * does not happen rather than a stage load that throws.
   */
  show(key: string, { stage, limit = null }: BriefingContext): boolean {
    const card = this.#cards[key];
    if (!card) return false;

    for (const other of Object.values(this.#cards)) other.hidden = other !== card;

    const timed = typeof limit === 'number' && Number.isFinite(limit);
    this.#stage.textContent = String(stage);
    // Whole seconds: this is a briefing about a clock, not a clock, and the tenths the
    // readout drops to are urgency rather than information.
    this.#clockLimit.textContent = formatClock(timed ? limit : Infinity, { tenths: false });
    this.#clockTimed.hidden = !timed;
    this.#clockUntimed.hidden = timed;

    this.hidden = false;
    return true;
  }

  hide(): void {
    this.hidden = true;
  }

  get open(): boolean {
    return !this.hidden;
  }
}

define('u-briefing', UBriefing);
