/**
 * What every component in `src/ui` is built on.
 *
 * A component is a folder of three files — the markup, the sheet, and this class — and the
 * two rules that make it self-contained are both here: its styles go into its own shadow
 * root, so no component can reach into another's internals by accident, and its markup is
 * its own `.html` file rather than a string smuggled into the script.
 *
 * Shadow DOM does not cut the components off from the design system, which is the usual
 * worry: custom properties inherit straight through a shadow boundary, so `--accent` and
 * `--mono` from `tokens.scss` reach every component without being handed to it. What does
 * *not* cross is class-based styling, and that is the point — a rule in one component's
 * sheet cannot land on another component's markup.
 */

/**
 * One `CSSStyleSheet` per unique sheet text, shared by every instance that adopts it.
 *
 * The alternative — a `<style>` per shadow root — parses the same CSS again for every stat
 * in the HUD and every button on a panel. Adopting one constructed sheet parses it once for
 * the whole page, which is the entire reason `adoptedStyleSheets` exists.
 */
const sheets = new Map<string, CSSStyleSheet>();

export function sheet(css: string): CSSStyleSheet {
  let found = sheets.get(css);
  if (!found) {
    found = new CSSStyleSheet();
    found.replaceSync(css);
    sheets.set(css, found);
  }
  return found;
}

export class UiElement extends HTMLElement {
  /** This component's shadow root. Every query in a component goes through it. */
  protected readonly root: ShadowRoot;

  /** Per-instance record of what has already been written — see `changed`. */
  readonly #last = new Map<string, unknown>();

  constructor(template: string, styles: string[]) {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.root.adoptedStyleSheets = styles.map(sheet);
    this.root.innerHTML = template;
  }

  /**
   * A required element from this component's own markup.
   *
   * Throws rather than returning null, because the failure it is guarding against is a
   * renamed hook in the `.html` file — which otherwise surfaces as a state that silently
   * never shows, on a stage nobody looks at until it matters.
   */
  protected $<T extends Element = HTMLElement>(selector: string): T {
    const found = this.root.querySelector<T>(selector);
    if (!found) {
      throw new Error(`<${this.localName}> has no element matching "${selector}"`);
    }
    return found;
  }

  protected all<T extends Element = HTMLElement>(selector: string): T[] {
    return [...this.root.querySelectorAll<T>(selector)];
  }

  /**
   * True the first time a key is given a value, and thereafter only when it differs.
   *
   * The HUD is written every frame and the DOM should not be. Every readout, class and
   * transform in these components goes through this, which is what keeps sixty identical
   * writes a second from becoming sixty style recalculations for one picture.
   */
  protected changed(key: string, value: unknown): boolean {
    if (this.#last.has(key) && this.#last.get(key) === value) return false;
    this.#last.set(key, value);
    return true;
  }

  /** Forgets what has been written, so the next write lands whatever it is told. */
  protected forget(...keys: string[]): void {
    for (const key of keys) this.#last.delete(key);
  }

  /** A composed event, so it crosses this component's shadow boundary to reach the Hud. */
  protected emit(type: string, detail?: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  /**
   * Restarts a CSS animation that may already be running.
   *
   * Dropping the class and adding it back in the same task is coalesced into no change at
   * all; reading a layout property in between forces the style flush that makes the second
   * write a real transition, which is what actually replays the animation.
   */
  protected replay(el: HTMLElement, className: string): void {
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
  }
}

/**
 * Registers a component, once.
 *
 * Guarded because a second `define` for the same tag throws, and the test suite imports
 * these modules into a fresh document more than once per run.
 */
export function define(tag: string, ctor: CustomElementConstructor): void {
  if (!customElements.get(tag)) customElements.define(tag, ctor);
}
