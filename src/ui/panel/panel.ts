import { define, UiElement } from '../base.ts';
import css from './panel.scss?inline';
import template from './panel.html?raw';

/**
 * The card an overlay centres. `variant` sets its measure and its alignment: `narrow` for a
 * list of controls, `brief` for prose, `interlude` for the one that holds a draining wash.
 */
export class UPanel extends UiElement {
  constructor() {
    super(template, [css]);
  }
}

define('u-panel', UPanel);
