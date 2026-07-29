import { COMBO, CURSED, INTERLUDE, ROPE } from './config.js';
import {
  expectedTime,
  recordClear,
  runsCounted,
  slackFor,
  slowestStruck,
  StageClock,
  stageDeadline,
} from './deadline.js';
import { generateStage, keepInside, playMargin } from './generator.js';
import { clamp, nearestOnPolyline } from './geometry.js';
import { MoveBudget } from './moves.js';
import { colorConvergence, stagePalette } from './palette.js';
import { saveProgress } from './progress.js';
import { makeRng, hashSeed } from './rng.js';
import { comboName, comboWindow, cursedStep, ScoreKeeper } from './scoring.js';
import { TangleTracker } from './tangle.js';

const MAX_DT = 50; // ms — a backgrounded tab must not fast-forward the settle
const BANNER_MS = 1100;
const FLASH_MS = 900;

/**
 * How long a combo callout is allowed to play before the results panel covers it.
 * The winning move is very often the biggest combo of the stage, and slamming the panel
 * up instantly is exactly when the player never gets to see it.
 */
const BANNER_HOLD_MS = 950;

/** A killed combo needs longer — it has to shake, then fall out of frame. */
const KILLED_BANNER_MS = 1500;

/** How long the cursed readout's jump lasts each time the multiplier climbs. */
const CURSED_POP_MS = 340;

/** Largest slice of a drag applied before length constraints run again. */
const SUBSTEP_LIMIT = 8;

/**
 * Where the combo total sits, and therefore where knot scores fly to. Directly under the
 * decay bar: the bar is how long you have, the number below it is what you would lose.
 */
const COMBO_ANCHOR_Y = 128;

export class Game {
  constructor({ renderer, hud, progress, baseSeed, debug, phone = false }) {
    this.renderer = renderer;
    this.hud = hud;
    this.progress = progress;
    // A record written before the clock existed has no times, and the clock reads and
    // writes this on every stage. Nothing to migrate — an empty history is exactly a new
    // player's, so those stages simply run untimed again — but it has to be an object
    // before the first clear is filed into it.
    this.progress.times ||= {};
    this.baseSeed = baseSeed;
    this.debug = debug;
    /** Phones play a thinned board — see STAGE.PHONE_SCALE. Fixed for the whole run. */
    this.phone = phone;

    this.state = 'title';
    this.stage = 1;
    this.width = 0;
    this.height = 0;
    this.margin = 0;

    this.ropes = [];
    this.tracker = null;
    this.score = new ScoreKeeper();
    this.budget = new MoveBudget();
    this.clock = new StageClock();
    this.stageScores = new Map();
    this.knotMarkers = [];
    this.flashes = [];
    this.banner = null;
    this.pending = null;
    this.explosions = [];

    /** Normal rung: 0 nothing, 1 primed (starter half-done), >=2 a live chain. */
    this.chain = 0;
    /** 0 while normal; >=COMBO.CURSED_BASE once the curse has taken the chain over. */
    this.cursedMult = 0;
    /** Which black rope the run is feeding on, and therefore which one a x10 blows. */
    this.curseTarget = -1;
    /** Counts down after each climb of the multiplier; drives the readout's jump. */
    this.cursedPop = 0;
    this.chainTimer = 0;

    this.grab = null;
    this.settle = null;
    this.pointer = { x: 0, y: 0 };
    this.stageInfo = null;

    /**
     * The between-stages sequence, or null while a stage is being played. Phases run
     * cleared -> swipe -> countdown -> go, and the last one hands the board over.
     */
    this.interlude = null;
    /** Holds the sequence where it stands. Only ever set from the PAUSE button. */
    this.paused = false;
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * Builds a board and leaves it sitting in `intro`, untouchable.
   *
   * Deliberately does not decide what happens next: the countdown that hands the board
   * over is the interlude's job, and the solved path needs the board swapped *underneath*
   * a card that is still sliding. Every route in goes through #enterStage.
   */
  loadStage(stage) {
    this.stage = stage;
    this.hud.hideGameOver();
    this.grab = null;
    this.settle = null;
    this.flashes.length = 0;
    this.explosions.length = 0;
    this.banner = null;
    this.pending = null;
    this.chain = 0;
    this.cursedMult = 0;
    this.curseTarget = -1;
    this.cursedPop = 0;
    this.chainTimer = 0;

    // A layout that generated with zero knots would be solved on arrival; walk the
    // seed forward until we get a real puzzle.
    let info = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      info = generateStage(
        stage,
        this.width,
        this.height,
        hashSeed(this.baseSeed + attempt * 7919, stage),
        { phone: this.phone },
      );
      if (info.knots > 0) break;
    }

    this.stageInfo = info;
    this.ropes = info.ropes;
    this.margin = info.margin;

    const palette = stagePalette(
      stage,
      this.ropes.length,
      makeRng(hashSeed(this.baseSeed ^ 0x5bf03635, stage)),
      this.progress.options.distinct,
    );
    this.ropes.forEach((rope, i) => {
      rope.color = palette[i];
    });

    this.tracker = new TangleTracker(this.ropes);
    this.score.beginStage(Math.hypot(this.width, this.height));
    this.budget.beginStage(info.moves.ideal, info.moves.bonus);
    // Null for a stage the player has never cleared, which is what makes a first look at
    // a board untimed — see deadline.js.
    this.clock.begin(stageDeadline(stage, this.progress.times));
    this.tracker.collectPoints(this.knotMarkers);
    this.state = 'intro';
  }

  /** Loads a stage and counts the player into it. */
  #enterStage(stage, taunt = false) {
    this.loadStage(stage);
    this.#beginCountdown(taunt);
  }

  /** Begins a fresh run: banked moves and accumulated score both start over. */
  start(stage = 1, taunt = false) {
    this.hud.hideTitle();
    this.stageScores.clear();
    this.budget.resetRun();
    this.#enterStage(stage, taunt);
  }

  /**
   * Straight in at the deep end, with the run's cushion and nothing else. The taunt is the
   * point of the button, so it rides along to the countdown that answers for it.
   */
  ripAndTear() {
    this.start(INTERLUDE.RIP_AND_TEAR_STAGE, true);
  }

  nextStage() {
    this.#enterStage(this.stage + 1);
  }

  retryStage() {
    if (this.state === 'title') return;
    this.#enterStage(this.stage);
  }

  /** Game over: the stage is replayable, but the bank is gone. */
  retryAfterGameOver() {
    this.budget.clearBank();
    this.#enterStage(this.stage);
  }

  /** PAUSE, and the same button again to resume. Only the interlude can be held. */
  togglePause() {
    if (!this.interlude) return;
    this.paused = !this.paused;
    this.hud.setPaused(this.paused);
  }

  restart() {
    this.progress.total = 0;
    this.progress.maxStage = 1;
    this.progress.best = {};
    // Clear times deliberately survive. They are a record of how fast this player works,
    // not of how far they got, and starting the ladder again does not make them someone
    // else — wiping them would also make "restart" the way to take the clock off a stage
    // that had got hard, which is the one thing the deadline must not be escapable by.
    saveProgress(this.progress);
    this.hud.hideSettings();
    this.start(1);
  }

  setOptions(options) {
    const wasDistinct = this.progress.options.distinct;
    this.progress.options = { ...this.progress.options, ...options };
    saveProgress(this.progress);

    // Recolour in place: the puzzle must not change just because the palette did.
    if (this.ropes.length && wasDistinct !== this.progress.options.distinct) {
      const palette = stagePalette(
        this.stage,
        this.ropes.length,
        makeRng(hashSeed(this.baseSeed ^ 0x5bf03635, this.stage)),
        this.progress.options.distinct,
      );
      this.ropes.forEach((rope, i) => {
        rope.color = palette[i];
      });
    }
  }

  get canRetry() {
    return this.state === 'playing' && !this.grab && !this.hud.anyOverlayOpen;
  }

  /**
   * Uniform scale about the centre: every knot is preserved exactly, so resizing
   * mid-stage can neither hand the player a solved board nor invent new work.
   */
  resize(width, height) {
    if (this.ropes.length && this.width > 0 && this.height > 0) {
      const scale = Math.min(width / this.width, height / this.height);
      const offsetX = width / 2 - (this.width / 2) * scale;
      const offsetY = height / 2 - (this.height / 2) * scale;
      for (const rope of this.ropes) rope.transform(scale, offsetX, offsetY);

      // The gesture lives in the old coordinate frame and has to come along. Left
      // behind, the next pointer move would snap the pinned node back to its pre-scale
      // position and bill the player for a jump they never made — which fires on every
      // mobile URL-bar collapse.
      this.pointer.x = this.pointer.x * scale + offsetX;
      this.pointer.y = this.pointer.y * scale + offsetY;
      if (this.grab) {
        this.grab.lastX = this.grab.lastX * scale + offsetX;
        this.grab.lastY = this.grab.lastY * scale + offsetY;
        this.grab.offsetX *= scale;
        this.grab.offsetY *= scale;
      }
    }

    this.width = width;
    this.height = height;
    this.margin = playMargin(width, height);
    this.renderer.resize(width, height);
    this.score.setDiagonal(Math.hypot(width, height));

    if (this.tracker) {
      // Refresh geometry only. A resize must never award or ratchet — the ratchet is
      // monotone, so an event swallowed here could never be recovered.
      this.tracker.recountAll();
      this.tracker.collectPoints(this.knotMarkers);
    }
  }

  // --- input -----------------------------------------------------------------

  onGrab(x, y, isTouch) {
    // Land any in-flight settle before deciding anything: it can be the thing that
    // clears the last knot, and grabbing onto a stage that just ended would leave
    // a rope held underneath the results panel.
    this.#finishSettle();
    if (this.state !== 'playing' || this.hud.anyOverlayOpen) return false;

    const reach = isTouch ? ROPE.GRAB_RADIUS_TOUCH : ROPE.GRAB_RADIUS_MOUSE;
    let best = null;

    for (let i = 0; i < this.ropes.length; i++) {
      if (this.ropes[i].removed) continue;
      // Heavy ropes are drawn thicker, so their grabbable area is wider too.
      const radius = reach + this.ropes[i].strokeWidth / 2;
      const hit = nearestOnPolyline(x, y, this.ropes[i].nodes);
      if (hit.distance <= radius && (!best || hit.distance < best.distance)) {
        best = { ropeIndex: i, nodeIndex: hit.index, distance: hit.distance };
      }
    }
    if (!best) return false;

    const rope = this.ropes[best.ropeIndex];
    const cost = this.#moveCost(best.ropeIndex);

    // Refuse a rope the player cannot pay for, rather than letting them commit to a drag
    // that ends the run on release.
    if (cost > this.budget.totalLeft) {
      const mid = midpointOf(rope);
      this.flashes.push({
        x: mid.x,
        y: mid.y,
        text: `Needs ${cost} moves`,
        tone: 'deny',
        life: FLASH_MS,
        total: FLASH_MS,
      });
      return false;
    }
    const node = rope.nodes[best.nodeIndex];
    this.grab = {
      ropeIndex: best.ropeIndex,
      nodeIndex: best.nodeIndex,
      // Locked in at grab time: the price the player agreed to when they picked it up,
      // not whatever the board happens to charge by the time they let go.
      cost,
      // Same reason — which curse's field this drag is pulling out of is decided by the
      // board the player looked at, not by whatever the settle leaves behind.
      curse: this.#cursedField(best.ropeIndex),
      weight: rope.weight,
      offsetX: x - node.x,
      offsetY: y - node.y,
      lastX: x,
      lastY: y,
    };
    this.pointer = { x, y };
    this.score.beginMove();
    this.tracker.mark();
    return true;
  }

  onMove(x, y) {
    if (!this.grab) return;
    // Clamping here keeps the pinned node reachable, so a rope can never be dragged
    // off the playfield and stranded.
    this.pointer.x = clamp(x, this.margin, this.width - this.margin);
    this.pointer.y = clamp(y, this.margin, this.height - this.margin);
  }

  onRelease() {
    if (!this.grab) return;
    const { ropeIndex, cost, curse, weight } = this.grab;
    this.grab = null;

    // A tap that moved nothing is not a move. Letting it through would run a settle,
    // and settle motion can resolve knots — handing out free untangles that cost
    // neither a move nor any travel.
    if (!this.score.endMove()) return;

    this.budget.spend(cost);
    if (cost > 1) this.hud.showMoveDelta(-cost);
    // Touching the cursed rope should feel like a mistake you can physically feel.
    if (this.ropes[ropeIndex].cursed) this.hud.shudder();

    this.settle = {
      ropeIndex,
      remaining: ROPE.SETTLE_MS,
      curse,
      weight,
      // Both verdicts are latched here, at the drop, and #endGesture is handed them
      // rather than re-deriving them when the settle finishes ~220ms later.
      //
      // The deadline is about when the player let go: a rope released with a tenth of a
      // second to spare has landed, and the clock running on through the settle must not
      // be able to take that back. The fumble is about where they let go: the settle is
      // unscored relaxation the game applies, so a rope that drifts onto a neighbour
      // during it is not the player parking it there.
      late: this.#chainRunning() && this.chainTimer <= 0,
      created: this.tracker.createdSinceMark(),
      // The stage clock, judged at the same instant and for the same reason. A rope
      // released with a moment to spare has landed, and the settle running on past the
      // buzzer is the game's time, not the player's — so a drop that clears the board at
      // 0.1s left is a win even though it finishes resolving after zero. Held past the
      // buzzer instead and this latches true: standing still with a rope in hand is not a
      // way to stop the clock.
      expired: this.clock.expired,
    };
  }

  /**
   * What dragging this rope costs right now.
   *
   * The cursed rope's tax is *dynamic*: it applies to whatever is crossing it at the
   * moment you grab, so clearing ropes off it makes the rest of the board cheaper. That
   * is the intended play — work outward from the black rope rather than through it.
   */
  #moveCost(index) {
    const rope = this.ropes[index];
    if (rope.cursed) return CURSED.GRAB_COST;
    return rope.weight * (this.#cursedField(index) >= 0 ? CURSED.DRAG_TAX : 1);
  }

  /** Any cursed rope still on the board, or -1. Only used as a fallback. */
  #anyCursedIndex() {
    return this.ropes.findIndex((rope) => rope.cursed && !rope.removed);
  }

  /**
   * Which cursed rope this one is caught on — still crossing it, and so taxed to double
   * move cost — or -1 for none. That tax is also what starts a CURSED COMBO, and the rope
   * it names is the one a x10 will detonate.
   *
   * A late board carries several black ropes, and the first one found is enough: the tax
   * is flat, so being caught on two is no more expensive than being caught on one.
   * Compounding it put ordinary ropes beyond the entire move budget, which reads as a
   * broken stage rather than a hard one.
   *
   * A black rope is deliberately *not* in its own field, nor in another black rope's.
   * Folding that in would make grabbing one worth six rungs, when the entire point of
   * repricing it was that it should be worth three.
   */
  #cursedField(index) {
    if (this.ropes[index].cursed) return -1;
    for (let k = 0; k < this.ropes.length; k++) {
      const rope = this.ropes[k];
      if (!rope.cursed || rope.removed) continue;
      if (this.tracker.knotsBetween(index, k) > 0) return k;
    }
    return -1;
  }

  // --- the combo ------------------------------------------------------------------------

  /** A run exists from the first knot onward — that is when the clock starts. */
  #chainRunning() {
    return this.chain >= 1;
  }

  #cursed() {
    return this.cursedMult >= COMBO.CURSED_BASE;
  }

  /** How fast the window burns. A cursed combo doubles the reward and the pressure both. */
  #burnRate() {
    return this.#cursed() ? COMBO.CURSED_BURN : 1;
  }

  /**
   * One qualifying drop.
   *
   * Every knot it took off the board is a rung and is banked into the run at once, priced
   * by the weight of the rope that was dragged: knots come off a triple rope worth three
   * times what they are worth off a light one. If the drop came out of the curse's field
   * and a run was already going, the cursed multiplier opens (or climbs, by the rope's
   * weight) — it multiplies the whole run, so there is nothing to multiply if no run is
   * live, and it cannot be started cold.
   *
   * `curse` is the black rope this drop was pulled off, or -1. It is remembered as the
   * run's target: on a board carrying several, the one that detonates at x10 has to be the
   * one the run was actually fed on, not whichever happens to sit first in the array.
   */
  #advance(points, curse, weight) {
    const running = this.chain >= 1;

    for (const point of points) {
      const gained = this.score.addKnot(weight);
      this.chain += 1;
      // Once the run is a combo the score flies up into the total; before that there is no
      // total to fly into, so it just rises where it was earned.
      this.flashes.push({
        x: point.x,
        y: point.y,
        toX: this.width / 2,
        toY: COMBO_ANCHOR_Y,
        fly: this.chain >= COMBO.SHOW_FROM,
        text: `+${Math.round(gained)}`,
        life: FLASH_MS,
        total: FLASH_MS,
      });
    }

    if (curse < 0) return;
    // The cursed multiplier acts on the whole run, so there has to *be* a run: it cannot
    // be opened cold, only on top of one already going.
    if (!this.#cursed() && !running) return;
    // Neutral at 1, and every rope hauled out of the field is worth the same as every
    // other — the opener included. See cursedStep.
    this.cursedMult = (this.#cursed() ? this.cursedMult : 1) + cursedStep(weight);
    this.curseTarget = curse;
    // The multiplier climbing *is* the reward, and a number that changes in place is easy
    // to miss underneath the shake the cursed readout already carries. Only fires when the
    // multiplier moves — an ordinary knot taken mid-curse climbs the rung, not this.
    this.cursedPop = CURSED_POP_MS;
  }

  /** One point per knot resolved, at the midpoint between the two ropes it joined. */
  #knotPoints(events) {
    const points = [];
    for (const event of events) {
      const a = midpointOf(this.ropes[event.i]);
      const b = midpointOf(this.ropes[event.j]);
      for (let k = 0; k < event.resolved; k++) {
        points.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
    }
    return points;
  }

  /**
   * Cost of the cheapest rope that is actually still in the player's way.
   *
   * Restricted to ropes still involved in a knot — those are the only ones anyone has
   * to move. Counting every rope on the board meant a stage where each *knotted* rope cost
   * more than the moves left still read as playable, because some rope lying clear in a
   * corner was cheap. That is not a reprieve, it is a deadlock: onGrab refuses any rope
   * the player cannot pay for, so they are left shuffling the one rope that changes
   * nothing until they give up. One move left and only double ropes knotted is a loss, and
   * the game should say so.
   */
  #cheapestMove() {
    let cheapest = Infinity;
    for (let i = 0; i < this.ropes.length; i++) {
      if (this.ropes[i].removed) continue;
      if (this.tracker.knotsFor(i) === 0) continue;
      cheapest = Math.min(cheapest, this.#moveCost(i));
    }
    return cheapest === Infinity ? 1 : cheapest;
  }

  /**
   * Blows a cursed rope off the board, free of charge. It stays in the ropes array so
   * every pair index the tracker holds stays valid — it is simply no longer on the board.
   *
   * The one that goes is the one the run was built on. On a late board carrying four, any
   * other choice means the player farms the black rope in front of them and a different one
   * explodes across the screen — the payoff has to land where the work was done. The
   * fallback is defensive only: a cursed rope leaves the board by detonating and nothing
   * else, and a run detonates once.
   */
  #detonateCursed() {
    const target = this.curseTarget;
    const index =
      target >= 0 && this.ropes[target]?.cursed && !this.ropes[target].removed
        ? target
        : this.#anyCursedIndex();
    if (index < 0) return false;

    const rope = this.ropes[index];
    const mid = midpointOf(rope);
    rope.removed = true;
    rope.markDirty();
    this.tracker.recount(index);

    this.explosions.push({ x: mid.x, y: mid.y, life: 750, total: 750 });
    return true;
  }

  // --- between stages --------------------------------------------------------

  /** Opens the countdown card. `taunt` is Rip & Tear's, and nothing else sets it. */
  #beginCountdown(taunt = false) {
    this.paused = false;
    this.interlude = { phase: 'countdown', remaining: INTERLUDE.COUNTDOWN_MS };
    this.hud.showCountdown(this.stage, taunt);
    this.hud.setCountdown(countdownText(INTERLUDE.COUNTDOWN_MS));
    this.hud.setPaused(false);
  }

  /**
   * Steps the sequence.
   *
   * The swipe is the one phase PAUSE cannot hold: it is a transition rather than a beat,
   * the stylesheet is already running it, and freezing the clock underneath a CSS
   * animation would strand one card halfway across the screen.
   */
  #updateInterlude(dt) {
    const stage = this.interlude;
    if (this.paused && stage.phase !== 'swipe') return;

    stage.remaining -= dt;

    if (stage.remaining > 0) {
      if (stage.phase === 'countdown') this.hud.setCountdown(countdownText(stage.remaining));
      return;
    }

    switch (stage.phase) {
      case 'cleared':
        // The next board is built here, underneath a card that is about to slide off it,
        // so what the countdown counts into is already there behind the panel.
        this.loadStage(this.stage + 1);
        stage.phase = 'swipe';
        stage.remaining = INTERLUDE.SWIPE_MS;
        this.hud.showCountdown(this.stage, false);
        this.hud.setCountdown(countdownText(INTERLUDE.COUNTDOWN_MS));
        break;

      case 'swipe':
        // Counting only starts once the card has arrived. A number ticking down while it
        // is still sliding reads as time the player was charged for before they could see.
        stage.phase = 'countdown';
        stage.remaining = INTERLUDE.COUNTDOWN_MS;
        break;

      case 'countdown':
        stage.phase = 'go';
        stage.remaining = INTERLUDE.GO_MS;
        this.hud.setCountdown('GO');
        break;

      default:
        this.interlude = null;
        this.hud.hideInterlude();
        this.state = 'playing';
    }
  }

  // --- simulation ------------------------------------------------------------

  update(dtMs, now) {
    const dt = Math.min(dtMs, MAX_DT);

    if (this.interlude) this.#updateInterlude(dt);

    if (this.grab) this.#updateDrag();
    else if (this.settle) this.#updateSettle(dt);

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      this.flashes[i].life -= dt;
      if (this.flashes[i].life <= 0) this.flashes.splice(i, 1);
    }
    if (this.cursedPop > 0) this.cursedPop = Math.max(0, this.cursedPop - dt);
    if (this.banner) {
      this.banner.life -= dt;
      if (this.banner.life <= 0) this.banner = null;
    }
    for (let i = this.explosions.length - 1; i >= 0; i--) {
      this.explosions[i].life -= dt;
      if (this.explosions[i].life <= 0) this.explosions.splice(i, 1);
    }
    if (this.pending) {
      this.pending.delay -= dt;
      if (this.pending.delay <= 0) this.#finishStage();
    }

    // The stage clock runs while the stage is being played and at no other time. A dialog
    // over the board is the one case that has to be excluded: the player cannot touch a
    // rope through it, so charging them for it would mean the settings button quietly
    // costs a run. Everything else — thinking, dragging, settling — is play, and is timed.
    const ticking = this.state === 'playing' && !this.hud.anyOverlayOpen;
    if (ticking) {
      this.clock.tick(dt);
      // Same guard the combo uses, for the same reason: a rope already dropped is a
      // landing #endGesture has not scored yet and carries its own latched verdict, and a
      // rope still in hand is judged when it is let go. Ending the stage from underneath
      // either would take away a move the player had already made.
      if (this.clock.expired && !this.grab && !this.settle) this.#timeUp();
    }

    // The window runs in real time from the *priming* drop — while the player is thinking,
    // while they are holding a rope, and while it settles. Starting it only at x2 is what
    // made a double reachable at a stroll: the first link sat armed indefinitely, so any
    // second drop, whenever it came, opened the chain. The clock has to be running for the
    // starter itself, or the starter is not a starter.
    if (this.#chainRunning() && this.state === 'playing') {
      this.chainTimer = Math.max(0, this.chainTimer - dt * this.#burnRate());
      // Only an *idle* lapse cashes here. A rope already dropped is a landing #endGesture
      // has not scored yet — it latched its own verdict at the drop — and a rope still in
      // hand is a move not yet made. Cashing under either would kill a chain from behind.
      if (this.chainTimer <= 0 && !this.grab && !this.settle) this.#cashCombo(false);
    }

    const knots = this.tracker ? this.tracker.count : 0;

    this.hud.setStats({
      stage: this.stage,
      knots,
      movesLeft: this.budget.stageLeft,
      bank: this.budget.bankLeft,
      // The alarm is about the *next* move, not the last one. Once the stage grant is
      // spent and knots are still on the board, every further move comes out of savings
      // — so the warning has to be up before the player commits to one, not after.
      drawingFromBank: this.budget.stageLeft === 0 && knots > 0,
      // Infinity on a stage with no record, which the readout shows as such. There is no
      // separate "untimed" flag to keep in step with the number.
      timeLeft: this.clock.remaining,
      // Projected, not banked: the pot is the player's, it is just not final yet.
      score: this.score.projected(this.cursedMult),
      chain: this.chain,
      cursedMult: this.cursedMult,
      chainFraction: this.#chainRunning()
        ? this.chainTimer / comboWindow(this.chain)
        : 0,
    });
  }

  #updateDrag() {
    const rope = this.ropes[this.grab.ropeIndex];
    const dx = this.pointer.x - this.grab.lastX;
    const dy = this.pointer.y - this.grab.lastY;
    if (dx === 0 && dy === 0) return;

    rope.snapshot();

    // A flick can move further in one frame than a segment is long, and eight
    // relaxation passes cannot absorb that in one go — the rope visibly stretches and
    // knots get counted against a shape it never really had. Walking the delta in
    // segment-sized slices keeps the chain taut.
    const steps = clamp(Math.ceil(Math.hypot(dx, dy) / rope.segLen), 1, SUBSTEP_LIMIT);
    const startX = this.grab.lastX;
    const startY = this.grab.lastY;

    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      rope.drag(dx / steps, dy / steps, this.grab.nodeIndex);
      rope.setNode(
        this.grab.nodeIndex,
        startX + dx * t - this.grab.offsetX,
        startY + dy * t - this.grab.offsetY,
      );
      rope.constrain(ROPE.DRAG_PASSES, this.grab.nodeIndex);
    }

    rope.clampTo(this.width, this.height, this.margin);
    rope.constrain(2, this.grab.nodeIndex);

    this.grab.lastX = this.pointer.x;
    this.grab.lastY = this.pointer.y;

    // Every node's displacement counts, and longer ropes have more nodes — hauling a
    // big rope really does cost more than nudging a small one.
    this.score.addDistance(rope.travelSinceSnapshot());
    this.tracker.recount(this.grab.ropeIndex);
    this.tracker.collectPoints(this.knotMarkers);
  }

  /**
   * Post-release settle: the rope relaxes into a natural curve. Deliberately *unscored*
   * — the player is only charged for motion they caused.
   */
  #updateSettle(dt) {
    const rope = this.ropes[this.settle.ropeIndex];
    const ease = Math.max(0, this.settle.remaining / ROPE.SETTLE_MS);

    rope.smooth(ROPE.SETTLE_SMOOTH * ease);
    rope.constrain(ROPE.SETTLE_PASSES);
    keepInside(rope, this.width, this.height, this.margin);
    this.tracker.recount(this.settle.ropeIndex);
    this.tracker.collectPoints(this.knotMarkers);

    this.settle.remaining -= dt;
    if (this.settle.remaining <= 0) this.#finishSettle();
  }

  #finishSettle() {
    if (!this.settle) return;
    const gesture = this.settle;
    this.settle = null;
    this.#endGesture(gesture);
  }

  /**
   * Ends the running chain and banks its pot.
   *
   * Every route out funnels through here — a fumble, a drop that untangled nothing, the
   * window lapsing, turning off the curse, and the stage ending — so the pot can never be
   * stranded. A chain still in its starter has nothing to pay and goes quietly.
   */
  #cashCombo(forfeited) {
    const rung = this.chain;
    const cursedMult = this.cursedMult;
    const wasCursed = this.#cursed();

    const cash = this.score.cashCombo(cursedMult, forfeited);
    this.chain = 0;
    this.cursedMult = 0;
    // The target dies with the run that chose it: the next run picks its own black rope.
    this.curseTarget = -1;
    // A jump left mid-flight would land on whatever the next run puts in the slot.
    this.cursedPop = 0;
    this.chainTimer = 0;
    if (!cash) return null;

    // The one and only callout a combo gets. It used to fire twice — once on landing the
    // rung and again on cashing it — which read as landing the same double or triple back
    // to back. The climb is already on screen continuously in the CHAIN readout; the
    // banner is for the moment it pays.
    const life = cash.forfeited ? KILLED_BANNER_MS : BANNER_MS;
    this.banner = {
      // Same wording as the live indicator it replaces, so the slot reads as resolving.
      multiplier: wasCursed ? `CURSED COMBO ×${cursedMult}` : `${rung} KNOTS`,
      // The ladder name is the curse's flourish and only the curse's, and it names the
      // *cursed* multiplier — the number already in the headline above it. A normal run
      // says what it was, the knot count, and nothing more.
      text: wasCursed ? comboName(cursedMult) : '',
      payout: `+${Math.round(cash.paid).toLocaleString()}`,
      killed: cash.forfeited,
      cursed: wasCursed,
      life,
      total: life,
    };
    return cash;
  }

  /**
   * One gesture, one evaluation. This is the only place points are awarded and the only
   * place the stage can end — which is what makes a move's value independent of frame
   * timing, and what stops a fast whip banking points on a separation that did not last.
   */
  #endGesture(gesture) {
    // All latched at the drop by onRelease. Did this move put a fresh knot on the board
    // — you untangled several ropes and then parked the one you were holding on another —
    // was the rope let go of before the combo window ran out, and was it let go of before
    // the stage clock did?
    const { created, late, curse, weight, expired } = gesture;
    let events = this.tracker.commit();
    let resolved = events.reduce((sum, e) => sum + e.resolved, 0);

    // The window ran out while the rope was in the air. That ends whatever was running —
    // letting it lapse is a landing, so it banks in full — but this drop is still clean in
    // its own right and primes a *new* chain. Cashing here, before its knots are counted,
    // is what keeps the two runs separate.
    if (late) this.#cashCombo(false);

    // The three conditions, all of them judged at the drop: it took something apart, it
    // parked nothing on another rope, and it landed in time.
    const qualifies = resolved > 0 && created === 0;

    if (qualifies) {
      const before = this.cursedMult;
      this.#advance(this.#knotPoints(events), curse, weight);

      // A cursed combo carried to MAX blows the black rope off the board and banks a move.
      // Its freed knots are knots this drop took, so they join the same run — at flat
      // weight, since no rope was hauled to get them.
      if (before < COMBO.MAX && this.cursedMult >= COMBO.MAX) {
        this.budget.grant(COMBO.REWARD_MOVES);
        this.hud.showBankDelta(COMBO.REWARD_MOVES);
        if (this.#detonateCursed()) {
          const freed = this.tracker.commit();
          events = events.concat(freed);
          this.#advance(this.#knotPoints(freed), -1, 1);
        }
      }

      // Reset on every knot, and measured from the drop that earned it.
      this.chainTimer = comboWindow(this.chain);
    } else {
      // A fumble strips the cursed multiplier; a drop that untangled nothing banks in full.
      this.#cashCombo(created > 0);
    }

    // Precision points, banked immediately and silently — they are not part of the combo,
    // and the player earned them whether or not a clock happened to be running. The number
    // shown at the knot is the knot's combo value, which is the one that is at stake.
    this.score.award(events);
    this.tracker.collectPoints(this.knotMarkers);

    // Out of moves is not only "zero left" — with heavy ropes on the board, being unable
    // to afford even the cheapest remaining rope is just as dead.
    const stuck = this.budget.totalLeft < this.#cheapestMove();
    // The clock outranks the board. This is the rope that was still in hand when the
    // buzzer went, so whatever it just achieved, it achieved out of time — a stage cannot
    // be won by holding a rope until the answer arrives.
    const finish = expired
      ? 'gameover'
      : this.tracker.count === 0
        ? 'solve'
        : stuck
          ? 'gameover'
          : null;
    if (!finish) return;

    this.#endStage(finish, expired ? 'time' : 'moves');
  }

  /** The clock ran out with nothing in flight. */
  #timeUp() {
    this.#endStage('gameover', 'time');
  }

  /**
   * The single way out of a stage, however it ended.
   *
   * A chain still running has to be paid out before the stage is scored, or the pot would
   * simply vanish — and that is as true of a stage lost to the clock as of one solved.
   * Then `ending` freezes input for a beat so a combo callout can land before the panel
   * covers the board.
   */
  #endStage(finish, reason) {
    this.#cashCombo(false);
    this.state = 'ending';
    this.pending = { finish, reason, delay: this.banner ? BANNER_HOLD_MS : 0 };
    if (this.pending.delay <= 0) this.#finishStage();
  }

  #finishStage() {
    const { finish, reason } = this.pending;
    this.pending = null;
    if (finish === 'solve') this.#solveStage();
    else this.#gameOver(reason);
  }

  /**
   * A cleared stage banks everything it earned and then gets out of the way.
   *
   * The run's numbers are still kept — best per stage, the run total, the clear time the
   * clock learns from — they are simply no longer read out at the player mid-run. A
   * scoreboard between every stage is a stop, and the stage after this one is already
   * being built behind the card that says you cleared this one.
   */
  #solveStage() {
    this.state = 'cleared';

    const score = this.score.score;
    const key = String(this.stage);
    const previousBest = this.progress.best[key] || 0;

    // Banks whatever the stage did not spend. Nothing reads the carry now that the
    // breakdown is gone, but the bank it feeds is on screen throughout the next stage.
    this.budget.settleStage();

    this.stageScores.set(this.stage, score);
    const runTotal = [...this.stageScores.values()].reduce((sum, v) => sum + v, 0);

    // Filed before anything else can touch the clock, and filed for the untimed first
    // clear above all — that clear is the only reason the stage can ever be timed at all.
    recordClear(this.progress.times, this.stage, this.clock.elapsed);

    this.progress.best[key] = Math.max(previousBest, score);
    this.progress.maxStage = Math.max(this.progress.maxStage, this.stage);
    this.progress.total = Math.max(this.progress.total, runTotal);
    saveProgress(this.progress);

    this.paused = false;
    this.interlude = { phase: 'cleared', remaining: INTERLUDE.CLEARED_MS };
    // What the stage paid, and what the run is worth now. The two numbers the player
    // actually wants off a scoreboard, without the scoreboard.
    this.hud.showCleared({ stage: this.stage, score, total: runTotal });
    this.hud.setPaused(false);
  }

  #gameOver(reason = 'moves') {
    this.state = 'gameover';
    this.hud.showGameOver({ stage: this.stage, knots: this.tracker.count, reason });
  }

  // --- render ----------------------------------------------------------------

  render(now) {
    this.renderer.draw({
      ropes: this.ropes,
      knots: this.knotMarkers,
      flashes: this.flashes,
      banner: this.banner,
      explosions: this.explosions,
      chain: this.chain,
      cursedMult: this.cursedMult,
      comboValue: this.score.comboValue(this.cursedMult),
      comboShowFrom: COMBO.SHOW_FROM,
      // Cursed runs only — see comboName. Empty the rest of the time, which is what keeps
      // the normal indicator down to a knot count and a number.
      comboName: this.#cursed() ? comboName(this.cursedMult) : '',
      // 1 on the frame the multiplier climbed, easing to 0. The renderer owns the shape of
      // the jump; the game only says when it was struck.
      cursedPop: this.cursedPop / CURSED_POP_MS,
      grabbedId: this.grab ? this.ropes[this.grab.ropeIndex].id : -1,
      showMarkers: this.progress.options.markers,
      margin: this.margin,
      time: now,
      debug: this.debug,
      debugLines: this.debug ? this.#debugLines() : null,
    });
  }

  #debugLines() {
    const info = this.stageInfo;
    const nodeCounts = this.ropes.map((r) => r.nodes.length).join(',');
    const weights = this.ropes.map((r) => r.weight).join(',');
    return [
      `stage ${this.stage}  ropes ${this.ropes.length}  knots ${this.tracker ? this.tracker.count : 0}` +
        (info ? ` (target ${info.spec.targetKnots})` : ''),
      info
        ? `cover ${info.moves.cover}  ideal ${info.moves.ideal}  bonus ${info.moves.bonus}  budget ${info.moves.budget}`
        : '',
      `moves used ${this.score.moves}  stage left ${this.budget.stageLeft}  bank ${this.budget.bankLeft}`,
      `nodes [${nodeCounts}]`,
      `weights [${weights}]  cheapest move ${this.#cheapestMove()}`,
      info
        ? `difficulty ${info.difficulty.toFixed(1)}  fits ${info.fits}  colour-converge ${(colorConvergence(this.stage, this.progress.options.distinct) * 100).toFixed(0)}%`
        : '',
      `travel ${this.score.distancePx.toFixed(0)}px  points ${this.score.points.toFixed(1)}  per-move ${this.score.perMove.toFixed(1)}  bestCombo x${this.score.bestCombo}`,
      `combo x${this.chain}${this.#cursed() ? `  CURSED x${this.cursedMult}` : ''}` +
        `  knots ${this.score.comboKnots}  accrued ${this.score.comboScore.toFixed(0)}  shown ${this.score.comboValue(this.cursedMult).toFixed(0)}` +
        `  window ${this.chainTimer.toFixed(0)}ms  burn x${this.#burnRate()}`,
      // Spelled out end to end, because "where did that number come from" is the one
      // question a self-calibrating deadline has to be able to answer on demand.
      `clock ${(this.clock.elapsed / 1000).toFixed(1)}s / ` +
        (this.clock.timed ? `${(this.clock.limit / 1000).toFixed(1)}s` : 'untimed') +
        `  runs ${(this.progress.times[String(this.stage)] || []).length}` +
        ` -> counted ${runsCounted(this.stage, this.progress.times).length}` +
        ` (struck ${slowestStruck(this.stage)})` +
        `  avg ${((expectedTime(this.stage, this.progress.times) || 0) / 1000).toFixed(1)}s` +
        `  slack ${slackFor(this.stage).toFixed(2)}`,
      `state ${this.state}${this.grab ? '  grabbing' : ''}${this.settle ? '  settling' : ''}`,
    ].filter(Boolean);
  }
}

function midpointOf(rope) {
  return rope.nodes[(rope.nodes.length / 2) | 0];
}

/** "3.00" down to "0.00". Hundredths because a number moving that fast reads as urgent. */
function countdownText(remaining) {
  return (Math.max(0, remaining) / 1000).toFixed(2);
}
