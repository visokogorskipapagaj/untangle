import type { UBriefing, BriefingContext } from './ui/briefing/briefing.ts';
import './ui/briefing/briefing.ts';
import type { UChainMeter } from './ui/chain-meter/chain-meter.ts';
import './ui/chain-meter/chain-meter.ts';
import type { UGameOver, GameOver } from './ui/game-over/game-over.ts';
import './ui/game-over/game-over.ts';
import type { UHud, HudStats } from './ui/hud/hud.ts';
import './ui/hud/hud.ts';
import type { UInterlude, ClearedStage } from './ui/interlude/interlude.ts';
import './ui/interlude/interlude.ts';
import type { USettings, GameOptions } from './ui/settings/settings.ts';
import './ui/settings/settings.ts';
import type { UTitleScreen, RunProgress } from './ui/title-screen/title-screen.ts';
import './ui/title-screen/title-screen.ts';

/**
 * The one object the game talks to about the screen.
 *
 * Everything visible is now a component that owns its own markup, styles and state, and this
 * is what stops that being the game's problem: `game.js` calls `showCleared` and `setStats`
 * exactly as it always did, and has no idea there are twelve custom elements behind them.
 *
 * So this file is wiring and nothing else. It finds the regions, forwards their events to
 * the handlers it was given, owns the hotkeys — which are page-wide and therefore belong to
 * no single component — and answers the one cross-cutting question, `anyOverlayOpen`.
 */

export interface HudHandlers {
  onStart(): void;
  onRipAndTear(): void;
  onPause(): void;
  onPlayStage(): void;
  onGameOverRetry(): void;
  onRestart(): void;
  onOptions(options: GameOptions): void;
  onRestartStage(): void;
}

/** Everything the game hands over on a frame: the readouts, plus the chain window. */
export interface HudFrame extends HudStats {
  chain?: number;
  chainFraction?: number;
  cursedMult?: number;
}

function required<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`index.html is missing ${selector}`);
  return found;
}

/**
 * The element that actually has focus, reaching through shadow roots to find it.
 *
 * `document.activeElement` stops at the outermost host: focus a button inside `<u-button>`
 * and it reports the `<u-button>`, not the `<button>`. The Enter hotkey stands down while a
 * button has focus, and without this it would never see one — so tabbing to PAUSE and
 * pressing Enter would pause and start the stage in the same keystroke.
 */
function focused(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

export class Hud {
  readonly #handlers: HudHandlers;

  readonly #root: HTMLElement;
  readonly #hud: UHud;
  readonly #chain: UChainMeter;
  readonly #title: UTitleScreen;
  readonly #interlude: UInterlude;
  readonly #briefing: UBriefing;
  readonly #gameover: UGameOver;
  readonly #settings: USettings;

  constructor(handlers: HudHandlers) {
    this.#handlers = handlers;

    // The whole playfield. It is what shudders, and it is not a component — the canvas
    // inside it belongs to the renderer.
    this.#root = required('#stage');
    this.#hud = required('u-hud');
    this.#chain = required('u-chain-meter');
    this.#title = required('u-title-screen');
    this.#interlude = required('u-interlude');
    this.#briefing = required('u-briefing');
    this.#gameover = required('u-game-over');
    this.#settings = required('u-settings');

    this.#title.addEventListener('start', () => handlers.onStart());
    this.#title.addEventListener('riptear', () => handlers.onRipAndTear());

    this.#interlude.addEventListener('pause', () => handlers.onPause());
    // Both green buttons are the same door: whatever is between the player and the board —
    // the CLEARED hold or a briefing — this is the way past it. The game decides which,
    // because it is the only thing that knows which one is up.
    this.#interlude.addEventListener('play', () => handlers.onPlayStage());
    this.#briefing.addEventListener('play', () => handlers.onPlayStage());

    this.#gameover.addEventListener('retry', () => handlers.onGameOverRetry());

    this.#settings.addEventListener('restart', () => handlers.onRestart());
    this.#settings.addEventListener('options', () => handlers.onOptions(this.#settings.options));

    this.#hud.addEventListener('settings', () => this.showSettings());
    // Gated the same way as the hotkey, and for the same reason: rerolling the stage costs
    // the player their progress on it, so it has to refuse mid-drag rather than reroll the
    // board out from under a rope that is currently in hand.
    this.#hud.addEventListener('restart-stage', () => handlers.onRestartStage());

    window.addEventListener('keydown', (e) => this.#onKey(e));
  }

  #onKey(e: KeyboardEvent): void {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      this.hideSettings();
      return;
    }
    // Gated on game state (no dialog, no drag in flight) and ignores auto-repeat.
    if (e.key === 'r' && !e.repeat) this.#handlers.onRestartStage();

    // Enter is the way past whatever is between the player and the board. Stood down while a
    // button has focus, because Enter already activates a focused button — hijacking it
    // there would fire both.
    if (e.key === 'Enter' && !e.repeat && focused()?.tagName !== 'BUTTON') {
      this.#handlers.onPlayStage();
    }
  }

  setOptions(options: Partial<GameOptions>): void {
    this.#settings.setOptions(options);
  }

  setStats(frame: HudFrame): void {
    this.#chain.update(frame.chain, frame.chainFraction, frame.cursedMult);
    this.#hud.setStats(frame);
  }

  /** The whole view flinches — used when the player drags the cursed rope. */
  shudder(): void {
    this.#root.classList.remove('is-shuddering');
    void this.#root.offsetWidth;
    this.#root.classList.add('is-shuddering');
  }

  showMoveDelta(amount: number): void {
    this.#hud.showMoveDelta(amount);
  }

  showBankDelta(amount: number): void {
    this.#hud.showBankDelta(amount);
  }

  showTitle(progress: RunProgress): void {
    this.#title.show(progress);
  }

  hideTitle(): void {
    this.#title.hide();
  }

  showCleared(cleared: ClearedStage): void {
    this.#interlude.showCleared(cleared);
  }

  setCountdown(fraction: number): void {
    this.#interlude.setCountdown(fraction);
  }

  setPaused(paused: boolean): void {
    this.#interlude.setPaused(paused);
  }

  hideInterlude(): void {
    this.#interlude.hide();
  }

  showBriefing(key: string, context: BriefingContext = { stage: 1 }): boolean {
    return this.#briefing.show(key, context);
  }

  hideBriefing(): void {
    this.#briefing.hide();
  }

  get briefingOpen(): boolean {
    return this.#briefing.open;
  }

  showGameOver(over: GameOver): void {
    this.#gameover.show(over);
  }

  hideGameOver(): void {
    this.#gameover.hide();
  }

  showSettings(): void {
    this.#settings.show();
  }

  hideSettings(): void {
    this.#settings.hide();
  }

  get settingsOpen(): boolean {
    return this.#settings.open;
  }

  /** True while anything is covering the board — input and hotkeys must stand down. */
  get anyOverlayOpen(): boolean {
    return [this.#settings, this.#interlude, this.#briefing, this.#gameover, this.#title].some(
      (el) => !el.hidden,
    );
  }
}
