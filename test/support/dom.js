import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Window } from 'happy-dom';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

/**
 * The globals a component module needs before it can even be imported.
 *
 * `class UButton extends HTMLElement` is evaluated at import time, and so is the
 * `customElements.define` under it — so this has to be installed before the first import
 * rather than before the first test. Everything a component reaches for during construction
 * belongs here for the same reason.
 */
const GLOBALS = [
  'window',
  'document',
  'customElements',
  'HTMLElement',
  'HTMLButtonElement',
  'HTMLInputElement',
  'SVGElement',
  'Element',
  'Node',
  'Event',
  'CustomEvent',
  'KeyboardEvent',
  'CSSStyleSheet',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame',
];

/**
 * A real DOM with the game's own page in it.
 *
 * The old harness was a hand-rolled `document` of about fifty lines, which was enough while
 * the HUD was ids and `classList` on a flat page. It cannot be enough now: these are custom
 * elements, and `attachShadow`, `adoptedStyleSheets` and element upgrade are the mechanism
 * rather than a detail of it — a stand-in that fakes them would be testing the stand-in.
 *
 * The page is index.html verbatim, so the tests still run against what actually ships.
 */
export function installDom() {
  const window = new Window({ url: 'http://localhost/' });
  // defineProperty rather than assignment: some of these already exist on Node's globalThis
  // as getter-only properties, and a plain write throws rather than shadowing them.
  for (const key of GLOBALS) {
    Object.defineProperty(globalThis, key, {
      value: window[key],
      writable: true,
      configurable: true,
    });
  }

  // Just the playfield — not the <script>, which would send happy-dom looking for a bundle,
  // and not the <head>, which is a viewport tag nothing here depends on. Nothing inside
  // #stage is a div, so the first closing tag is its own.
  const stage = read('index.html').match(/<div id="stage">[\s\S]*?<\/div>/);
  if (!stage) throw new Error('index.html no longer has a #stage container to mount');
  window.document.body.innerHTML = stage[0];

  return window;
}
