import { CLOCK, COMBO, MOVES } from './config.js';
import { formatClock } from './deadline.js';
import { formatScore } from './scoring.js';

const $ = (id) => document.getElementById(id);

/** Fraction of the window left at which the chain meter goes red and buzzes. */
const CHAIN_CRITICAL = 0.15;

export class Hud {
  constructor(handlers) {
    this.handlers = handlers;
    this.last = {};

    this.el = {
      stage: $('stat-stage'),
      knots: $('stat-knots'),
      knotsBox: document.querySelector('.stat--knots'),
      movesLeft: $('stat-moves'),
      movesBox: document.querySelector('.stat--moves'),
      movesDelta: $('stat-moves-delta'),
      time: $('stat-time'),
      timeBox: document.querySelector('.stat--time'),
      chainBar: $('chain-bar'),
      chainFill: $('chain-bar-fill'),
      // The whole playfield container. Deliberately NOT named `stage` — `setStats`
      // writes `this.el[key].textContent` for each stat key, and a collision with the
      // stage-number element would blank the entire page on the first frame.
      root: $('stage'),
      bank: $('stat-bank'),
      bankBox: document.querySelector('.stat--bank'),
      bankDelta: $('stat-bank-delta'),
      score: $('stat-score'),

      title: $('overlay-title'),
      titleBest: $('title-best'),
      gameover: $('overlay-gameover'),
      settings: $('overlay-settings'),

      interlude: $('overlay-interlude'),
      cardCleared: $('card-cleared'),
      cardCountdown: $('card-countdown'),
      clearedStage: $('cleared-stage'),
      clearedScore: $('cleared-score'),
      clearedTotal: $('cleared-total'),
      countdownStage: $('countdown-stage'),
      countdownValue: $('countdown-value'),
      countdownTaunt: $('countdown-taunt'),
      pause: $('btn-pause'),
      pauseLabel: $('pause-label'),
      skip: $('btn-skip'),

      overStage: $('over-stage'),
      overReason: $('over-reason'),
      overDetail: $('over-detail'),

      optDistinct: $('opt-distinct'),
      optMarkers: $('opt-markers'),
    };

    $('btn-start').addEventListener('click', () => handlers.onStart());
    $('btn-riptear').addEventListener('click', () => handlers.onRipAndTear());
    $('btn-pause').addEventListener('click', () => handlers.onPause());
    $('btn-skip').addEventListener('click', () => handlers.onSkip());
    $('btn-over-retry').addEventListener('click', () => handlers.onGameOverRetry());
    $('btn-restart').addEventListener('click', () => handlers.onRestart());
    // Same gated handler as the hotkey, for the same reason: rerolling the stage costs the
    // player their progress on it, so it has to refuse mid-drag rather than reroll the
    // board out from under a rope that is currently in hand.
    $('btn-restart-stage').addEventListener('click', () => handlers.onRestartStage());
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
      // Gated on game state (no dialog, no drag in flight) and ignores auto-repeat.
      if (e.key === 'r' && !e.repeat) handlers.onRestartStage();

      // Enter skips the wait between stages. Stood down while a button has focus, because
      // Enter already activates a focused button — hijacking it there would fire both, so
      // tabbing to PAUSE and pressing Enter would pause and skip in the same keystroke.
      if (e.key === 'Enter' && !e.repeat && document.activeElement?.tagName !== 'BUTTON') {
        handlers.onSkip();
      }
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
    knots,
    movesLeft,
    bank,
    drawingFromBank,
    bankFull,
    timeLeft,
    score,
    chain,
    chainFraction,
    cursedMult,
  }) {
    this.#setChainBar(chain, chainFraction, cursedMult);

    const next = {
      stage: String(stage),
      // Infinity formats as the infinity sign, which is how an untimed stage reads.
      time: formatClock(timeLeft),
      knots: String(knots),
      movesLeft: String(movesLeft),
      bank: String(bank),
      score: formatScore(score),
    };

    for (const key of Object.keys(next)) {
      const el = this.el[key];
      if (el && this.last[key] !== next[key]) {
        el.textContent = next[key];
        this.last[key] = next[key];
      }
    }

    const clear = knots === 0;
    if (this.last.clear !== clear) {
      this.el.knotsBox.classList.toggle('is-clear', clear);
      this.last.clear = clear;
    }

    // Three states, and only one class changes at a time — same write-what-changed rule
    // as everything else here, which also stops the critical pulse restarting each frame.
    const timeLevel = !Number.isFinite(timeLeft)
      ? 'untimed'
      : timeLeft <= CLOCK.CRITICAL_MS
        ? 'critical'
        : timeLeft <= CLOCK.WARN_MS
          ? 'low'
          : '';
    if (this.last.timeLevel !== timeLevel) {
      this.el.timeBox.classList.toggle('is-untimed', timeLevel === 'untimed');
      this.el.timeBox.classList.toggle('is-low', timeLevel === 'low');
      this.el.timeBox.classList.toggle('is-critical', timeLevel === 'critical');
      this.last.timeLevel = timeLevel;
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

    // Full: whatever this stage leaves over is lost rather than carried. Quiet, because
    // it is a nudge to spend rather than a problem, and it must not compete with the
    // alarm above — burning wins outright, since that one costs the player a run.
    const full = !!bankFull && !drawingFromBank;
    if (this.last.bankFull !== full) {
      this.el.bankBox.classList.toggle('is-full', full);
      this.last.bankFull = full;
    }
  }

  /**
   * Drains as the chain window runs out. Width is written every frame, but only while a
   * chain is live — the bar is hidden the rest of the time, so there is no idle churn.
   */
  #setChainBar(chain = 0, fraction = 0, cursedMult = 0) {
    const cursed = cursedMult >= COMBO.CURSED_BASE;
    // Live from the *priming* drop, not from x2. The clock starts there, and a running
    // deadline the player cannot see is the one thing this bar exists to prevent — that
    // is a separate question from whether there is a rung worth shouting about yet.
    const live = chain >= 1 || cursed;
    if (this.last.chainLive !== live) {
      this.el.chainBar.classList.toggle('is-live', live);
      this.last.chainLive = live;
      // Drop the alarm states on the way out, or the buzz and blink animations keep
      // running on a bar nobody can see.
      if (!live) {
        this.el.chainBar.classList.remove('is-critical', 'is-hot', 'is-cursed', 'is-priming');
        this.last.chainCritical = false;
        this.last.chainHot = false;
        this.last.chainCursed = false;
        this.last.chainPriming = false;
      }
    }
    if (!live) return;

    const left = Math.max(0, Math.min(1, fraction));

    const hot = (cursed ? cursedMult : chain) >= 7;
    if (this.last.chainHot !== hot) {
      this.el.chainBar.classList.toggle('is-hot', hot);
      this.last.chainHot = hot;
    }

    // Still priming: the starter is half done and the clock is running, but no rung has
    // been earned. Dimmer and thinner, so it reads as a countdown rather than a stake.
    const priming = !cursed && chain < 2;
    if (this.last.chainPriming !== priming) {
      this.el.chainBar.classList.toggle('is-priming', priming);
      this.last.chainPriming = priming;
    }

    // A CURSED COMBO burns the window at double rate, so the meter has to stop looking
    // like the same meter: it doubles in height and blinks.
    if (this.last.chainCursed !== cursed) {
      this.el.chainBar.classList.toggle('is-cursed', cursed);
      this.last.chainCursed = cursed;
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

  /**
   * The card that says you cleared it, and what it paid. Holds, then gets swiped off by
   * showCountdown.
   */
  showCleared({ stage, score, total }) {
    this.el.clearedStage.textContent = String(stage);
    this.el.clearedScore.textContent = formatScore(score);
    this.el.clearedTotal.textContent = formatScore(total);
    this.el.interlude.classList.remove('is-hidden');
    this.#showCard(this.el.cardCleared);
    this.#hideCard(this.el.cardCountdown);
  }

  /**
   * The countdown card.
   *
   * If the cleared card is up this is a swap, and the two animate as a pair — one out to
   * the left, one in from the right. Coming from the title or a retry there is nothing to
   * replace, so it simply arrives.
   */
  showCountdown(stage, taunt = false) {
    this.el.countdownStage.textContent = String(stage);
    this.el.countdownTaunt.classList.toggle('is-hidden', !taunt);
    this.el.interlude.classList.remove('is-hidden');

    const swapping = !this.el.cardCleared.classList.contains('is-hidden');
    if (swapping) {
      this.el.cardCleared.classList.remove('is-entering');
      this.el.cardCleared.classList.add('is-leaving');
    }
    this.#showCard(this.el.cardCountdown, swapping);
  }


  /** The number itself, or GO. Written every frame while the count runs. */
  setCountdown(text) {
    if (this.last.countdown === text) return;
    this.el.countdownValue.textContent = text;
    // GO is the payoff, and it wants to land rather than merely appear.
    this.el.countdownValue.classList.toggle('is-go', text === 'GO');
    this.last.countdown = text;
  }

  /**
   * Flips the pause control between pause and resume.
   *
   * The label is written to `aria-label`/`title` rather than to the button's text, because
   * the button's content is now two inline SVGs and `textContent =` would delete them —
   * leaving a control that still works, still reads correctly to a screen reader, and is
   * simply invisible from the first time anyone pauses.
   *
   * Which icon shows is the stylesheet's job, keyed off `is-paused` on the overlay. That
   * class was already being toggled here, so there is no second thing to keep in step.
   */
  setPaused(paused) {
    if (this.last.paused === paused) return;
    const label = paused ? 'Resume' : 'Pause';
    // Into the span, never the button. The button's own content is the two icons, and
    // `this.el.pause.textContent =` would delete them — leaving a control that still works,
    // still reads correctly to a screen reader, and is simply invisible from then on.
    this.el.pauseLabel.textContent = label;
    this.el.pause.setAttribute('title', label);
    this.el.interlude.classList.toggle('is-paused', paused);
    this.last.paused = paused;
  }

  hideInterlude() {
    this.el.interlude.classList.add('is-hidden');
    this.#hideCard(this.el.cardCleared);
    this.#hideCard(this.el.cardCountdown);
  }

  /**
   * Restarting a CSS animation needs the class dropped and the style flushed; without the
   * reflow read the browser coalesces both writes and the card arrives already in place.
   */
  #showCard(card, entering = false) {
    card.classList.remove('is-hidden', 'is-leaving', 'is-entering');
    if (!entering) return;
    void card.offsetWidth;
    card.classList.add('is-entering');
  }

  #hideCard(card) {
    card.classList.add('is-hidden');
    card.classList.remove('is-leaving', 'is-entering');
  }

  /**
   * Two ways to lose, and the panel has to say which — the moves counter and the clock sit
   * at opposite ends of the HUD, and a player who has just had the board taken away from
   * them should not have to work out which of the two ran out.
   */
  showGameOver({ stage, knots, reason = 'moves' }) {
    const left = `${knots} knot${knots === 1 ? '' : 's'}`;
    this.el.overStage.textContent = String(stage);
    this.el.overReason.textContent = reason === 'time' ? 'Out of time' : 'Out of moves';
    // Which of the two ran out, said plainly. The moves counter and the clock sit at
    // opposite ends of the HUD, and somebody who has just had the board taken off them
    // should not have to work out which one did it.
    this.el.overDetail.textContent =
      reason === 'time'
        ? `Clock got you. ${left} still sitting there.`
        : `That's the moves gone, and ${left} to show for it.`;
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
    return [this.el.settings, this.el.interlude, this.el.gameover, this.el.title].some(
      (el) => !el.classList.contains('is-hidden'),
    );
  }
}
