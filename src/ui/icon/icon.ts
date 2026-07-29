import { define, UiElement } from '../base.ts';
import css from './icon.scss?inline';
import template from './icon.html?raw';

/**
 * One piece of artwork, named.
 *
 * The four icons used to be pasted into the markup wherever they were needed — the reload
 * glyph three times, the double arrow twice — which is how the two copies of the same icon
 * end up drifting apart. Here there is one copy of each and a name for it.
 */

/** name -> the `<svg>` for it, parsed out of icon.html once for the whole page. */
const catalogue = new Map<string, SVGElement>();
{
  const holder = document.createElement('div');
  holder.innerHTML = template;
  for (const art of holder.querySelectorAll<SVGElement>('svg[data-icon]')) {
    catalogue.set(art.getAttribute('data-icon') ?? '', art);
  }
}

export class UIcon extends UiElement {
  static readonly observedAttributes = ['name'];

  constructor() {
    // No template of its own: what it draws depends on the name it is given.
    super('', [css]);
  }

  attributeChangedCallback(): void {
    this.#draw();
  }

  connectedCallback(): void {
    this.#draw();
  }

  #draw(): void {
    const name = this.getAttribute('name') ?? '';
    if (!this.changed('name', name)) return;

    const art = catalogue.get(name);
    // Loud, because the alternative is a button that renders as an empty box and looks
    // like a styling problem rather than a typo in a name.
    if (!art) throw new Error(`<u-icon> has no icon named "${name}"`);

    this.root.replaceChildren(art.cloneNode(true));
  }
}

define('u-icon', UIcon);
