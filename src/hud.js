import { MOVES } from './config.js';
import { formatDistance, formatScore } from './scoring.js';

const $ = (id) => document.getElementById(id);

/** Fraction of the window left at which the chain meter goes red and buzzes. */
const CHAIN_CRITICAL = 0.15;

export class Hud {
  constructor(handlers) {
    this.handlers = handlers;
    this.last = {};

    this.el = {
      stage: $('stat-stage'),
      crossings: $('stat-crossings'),
      crossingsBox: document.querySelector('.stat--crossings'),
      movesLeft: $('stat-moves'),
      movesBox: document.querySelector('.stat--moves'),
      movesDelta: $('stat-moves-delta'),
      chainBar: $('chain-bar'),
      chainFill: $('chain-bar-fill'),
      // The whole playfield container. Deliberately NOT named `stage` — `setStats`
      // writes `this.el[key].textContent` for each stat key, and a collision with the
      // stage-number element would blank the entire page on the first frame.
      root: $('stage'),
      bank: $('stat-bank'),
      bankBox: document.querySelector('.stat--bank'),
      bankDelta: $('stat-bank-delta'),
      distance: $('stat-distance'),
      score: $('stat-score'),

      title: $('overlay-title'),
      titleBest: $('title-best'),
      solved: $('overlay-solved'),
      gameover: $('overlay-gameover'),
      settings: $('overlay-settings'),

      solvedStage: $('solved-stage'),
      solvedScore: $('solved-score'),
      solvedCombo: $('solved-combo'),
      solvedUntangles: $('solved-untangles'),
      solvedMoves: $('solved-moves'),
      solvedCarried: $('solved-carried'),
      solvedBank: $('solved-bank'),
      solvedDistance: $('solved-distance'),
      solvedTightness: $('solved-tightness'),
      solvedEfficiency: $('solved-efficiency'),
      solvedBest: $('solved-best'),
      solvedTotal: $('solved-total'),

      overStage: $('over-stage'),
      overDetail: $('over-detail'),

      optDistinct: $('opt-distinct'),
      optMarkers: $('opt-markers'),
    };

    $('btn-start').addEventListener('click', () => handlers.onStart());
    $('btn-next').addEventListener('click', () => handlers.onNext());
    $('btn-retry').addEventListener('click', () => handlers.onRetry());
    $('btn-over-retry').addEventListener('click', () => handlers.onGameOverRetry());
    $('btn-restart').addEventListener('click', () => handlers.onRestart());
    $('btn-settings').addEventListener('click', () => this.showSettings());
    $('btn-close-settings').addEventListener('click', () => this.hideSettings());

    this.el.optDistinct.addEventListener('change', () => this.#emitOptions());
    this.el.optMarkers.addEventListener('change', () => this.#emitOptions());

    window.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'Escape') {
        this.hideSettings();
        return;
      }
      // Rerolling the stage costs the player their progress on it, so the hotkey is
      // gated on game state (no dialog, no drag in flight) and ignores auto-repeat.
      if (e.key === 'r' && !e.repeat) handlers.onHotkeyRetry();
    });
  }

  #emitOptions() {
    this.handlers.onOptions({
      distinct: this.el.optDistinct.checked,
      markers: this.el.optMarkers.checked,
    });
  }

  setOptions(options) {
    this.el.optDistinct.checked = !!options.distinct;
    this.el.optMarkers.checked = !!options.markers;
  }

  /** Writes only what changed — the HUD updates every frame, the DOM should not. */
  setStats({
    stage,
    crossings,
    movesLeft,
    bank,
    drawingFromBank,
    distancePx,
    score,
    chain,
    chainFraction,
  }) {
    this.#setChainBar(chain, chainFraction);

    const next = {
      stage: String(stage),
      crossings: String(crossings),
      movesLeft: String(movesLeft),
      bank: String(bank),
      distance: formatDistance(distancePx),
      score: formatScore(score),
    };

    for (const key of Object.keys(next)) {
      const el = this.el[key];
      if (el && this.last[key] !== next[key]) {
        el.textContent = next[key];
        this.last[key] = next[key];
      }
    }

    const clear = crossings === 0;
    if (this.last.clear !== clear) {
      this.el.crossingsBox.classList.toggle('is-clear', clear);
      this.last.clear = clear;
    }

    const level = movesLeft === 0 ? 'empty' : movesLeft <= MOVES.LOW_WARNING ? 'low' : '';
    if (this.last.moveLevel !== level) {
      this.el.movesBox.classList.toggle('is-low', level === 'low');
      this.el.movesBox.classList.toggle('is-empty', level === 'empty');
      this.last.moveLevel = level;
    }

    // Lit while the next move will come out of savings — the player needs to see the
    // cost before committing to the move, not after paying it.
    if (this.last.drawingFromBank !== drawingFromBank) {
      this.el.bankBox.classList.toggle('is-burning', !!drawingFromBank);
      this.last.drawingFromBank = drawingFromBank;
    }
  }

  /**
   * Drains as the chain window runs out. Width is written every frame, but only while a
   * chain is live — the bar is hidden the rest of the time, so there is no idle churn.
   */
  #setChainBar(chain = 0, fraction = 0) {
    // x1 is not a state — a single untangle is just a move. The chain becomes a thing
    // the player is holding at x2.
    const live = chain >= 2;
    if (this.last.chainLive !== live) {
      this.el.chainBar.classList.toggle('is-live', live);
      this.last.chainLive = live;
      // Drop the alarm state on the way out, or the buzz animation keeps running on a
      // bar nobody can see.
      if (!live) {
        this.el.chainBar.classList.remove('is-critical', 'is-hot');
        this.last.chainCritical = false;
        this.last.chainHot = false;
      }
    }
    if (!live) return;

    const left = Math.max(0, Math.min(1, fraction));

    const hot = chain >= 7;
    if (this.last.chainHot !== hot) {
      this.el.chainBar.classList.toggle('is-hot', hot);
      this.last.chainHot = hot;
    }

    const critical = left <= CHAIN_CRITICAL;
    if (this.last.chainCritical !== critical) {
      this.el.chainBar.classList.toggle('is-critical', critical);
      this.last.chainCritical = critical;
    }

    const scale = left.toFixed(3);
    if (this.last.chainScale !== scale) {
      this.el.chainFill.style.transform = `scaleX(${scale})`;
      this.last.chainScale = scale;
    }
  }

  /** The whole view flinches — used when the player drags the cursed rope. */
  shudder() {
    const el = this.el.root;
    if (!el) return;
    el.classList.remove('is-shuddering');
    void el.offsetWidth;
    el.classList.add('is-shuddering');
  }

  /** Red "-3" beside the move counter when a drag costs more than one move. */
  showMoveDelta(amount) {
    this.#fireDelta(this.el.movesDelta, `${amount}`);
  }

  /** Green "+1" beside the bank when moves are earned. */
  showBankDelta(amount) {
    this.#fireDelta(this.el.bankDelta, `+${amount}`);
  }

  #fireDelta(el, text) {
    if (!el) return;
    el.textContent = text;
    // Restarting a running CSS animation needs the class dropped and the style flushed;
    // without the reflow read the browser coalesces both writes and nothing replays.
    el.classList.remove('is-firing');
    void el.offsetWidth;
    el.classList.add('is-firing');
  }

  showTitle(progress) {
    this.el.title.classList.remove('is-hidden');
    this.el.titleBest.textContent =
      progress.maxStage > 1
        ? `Best run: stage ${progress.maxStage} · ${formatScore(progress.total)} points`
        : '';
  }

  hideTitle() {
    this.el.title.classList.add('is-hidden');
  }

  showSolved(s) {
    this.el.solvedStage.textContent = String(s.stage);
    this.el.solvedScore.textContent = formatScore(s.score);
    this.el.solvedUntangles.textContent = String(s.untangles);
    this.el.solvedMoves.textContent = `${s.used} / ${s.ideal + s.bonus}`;
    this.el.solvedCarried.textContent = s.carried >= 0 ? `+${s.carried}` : String(s.carried);
    this.el.solvedBank.textContent = String(s.bank);
    this.el.solvedCombo.textContent = s.bestCombo > 1 ? `×${s.bestCombo}` : '—';
    this.el.solvedDistance.textContent = formatDistance(s.distancePx);
    this.el.solvedTightness.textContent = `×${s.avgTightness.toFixed(2)}`;
    this.el.solvedEfficiency.textContent = `${Math.round(s.avgEfficiency * 100)}%`;
    this.el.solvedBest.textContent = s.best ? formatScore(s.best) : '—';
    this.el.solvedTotal.textContent = formatScore(s.total);
    this.el.solved.classList.remove('is-hidden');
  }

  hideSolved() {
    this.el.solved.classList.add('is-hidden');
  }

  showGameOver({ stage, crossings }) {
    this.el.overStage.textContent = String(stage);
    this.el.overDetail.textContent =
      `Uh-oh, you ran out of moves with ${crossings} knot${crossings === 1 ? '' : 's'} remaining.`;
    this.el.gameover.classList.remove('is-hidden');
  }

  hideGameOver() {
    this.el.gameover.classList.add('is-hidden');
  }

  showSettings() {
    this.el.settings.classList.remove('is-hidden');
  }

  hideSettings() {
    this.el.settings.classList.add('is-hidden');
  }

  get settingsOpen() {
    return !this.el.settings.classList.contains('is-hidden');
  }

  /** True while anything is covering the board — input and hotkeys must stand down. */
  get anyOverlayOpen() {
    return [this.el.settings, this.el.solved, this.el.gameover, this.el.title].some(
      (el) => !el.classList.contains('is-hidden'),
    );
  }
}
