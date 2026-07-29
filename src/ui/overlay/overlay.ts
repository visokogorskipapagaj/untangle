import { define, UiElement } from '../base.ts';
import css from './overlay.scss?inline';
import template from './overlay.html?raw';

/**
 * The scrim a panel sits on. No behaviour of its own — which panel is up, and when, is the
 * business of the region that owns it.
 */
export class UOverlay extends UiElement {
  constructor() {
    super(template, [css]);
  }
}

define('u-overlay', UOverlay);
