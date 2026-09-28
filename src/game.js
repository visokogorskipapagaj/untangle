import { ComboRun } from './combo.js';
import { BRIEFING, CLOCK, COMBO, COMBO_TOTAL_Y, CURSED, INTERLUDE, ROPE } from './config.js';
import {
  expectedTime,
  recordClear,
  runsCounted,
  slackFor,
  StageClock,
  stageDeadline,
  targetFor,
  thinFor,
} from './deadline.js';
import { generateStage, keepInside, playMargin } from './generator.js';
import { clamp, nearestOnPolyline } from './geometry.js';
import { MoveBudget } from './moves.js';
import { colorConvergence, stagePalette } from './palette.js';
import { saveProgress } from './progress.js';
import { makeRng, hashSeed } from './rng.js';
import { comboName, ScoreKeeper } from './scoring.js';
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

/** Largest slice of a drag applied before length constraints run again. */
const SUBSTEP_LIMIT = 8;

/**
 * Quadratic ease-out, for the endgame ramps — 0 and 1 still land exactly on 0 and 1, and
 * the midpoint sits at 0.75 rather than 0.5.
 *
 * Quadratic rather than cubic on purpose. Cubic puts the midpoint at 0.875, which on the
 * wash means the board is within a whisker of its reddest for the whole back half of the
 * endgame — an alarm that arrives at full and then has nothing left to say. Quadratic is
 * decisive at the threshold and still has somewhere to go afterwards.
 */
const easeOut = (t) => 1 - (1 - t) * (1 - t);

export class Game {
  /**
   * The game's only entry point, and the one signature the UI layer has to agree with.
   *
   * Spelled out because `pool` defaults to null: without this a type checker reads that
   * default as the whole of what the parameter accepts, and main.ts — which passes a real
   * Pool whenever `?pool=0` is absent — becomes an error against a game that has always
   * taken one.
   *
   * `hud` is deliberately loose. Three test files drive this class through a stub that
   * records calls rather than through the real one, and that is the point of the seam.
   *
   * @param {{
   *   renderer: import('./render.js').Renderer,
   *   hud: any,
   *   progress: any,
   *   pool?: import('./pool.js').Pool | null,
   *   baseSeed: number,
   *   debug?: boolean,
   *   phone?: boolean,
   * }} options
   */
  constructor({ renderer, hud, progress, pool = null, baseSeed, debug, phone = false }) {
    this.renderer = renderer;
    this.hud = hud;
    this.progress = progress;
    /**
     * The shared pool, or null to play entirely off this device's own times — which is
     * what the tests and any offline harness do, and is the behaviour the game had before
     * there was a pool. Never awaited: `pool.pars` is read synchronously on stage load and
     * is whatever has arrived by then.
     */
    this.pool = pool;
    // A record written before the clock existed has no times, and the clock reads and
    // writes this on every stage. Nothing to migrate — an empty history is exactly a new
    // player's, so those stages simply run untimed again — but it has to be an object
    // before the first clear is filed into it.
    this.progress.times ||= {};
    // Which briefings this record has already been shown. Same story as times: absent on
    // any record written before they existed, and an empty one is exactly a new player's.
    this.progress.briefed ||= {};
    this.baseSeed = baseSeed;
    this.debug = debug;
    /** Phones play a thinned board — see STAGE.PHONE_SCALE. Fixed for the whole run. */
    this.phone = phone;

    this.state = 'title';
    this.stage = 1;
    this.width = 0;
    this.height = 0;
    this.margin = 0;
    /**
     * The viewport the current board was generated in, and how far the board has been
     * scaled from it. Every resize fits the frame afresh rather than scaling the previous
     * viewport, so a phone rotated and rotated back lands exactly where it started.
     */
    this.frame = null;
    this.fit = 1;

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

    /** The running combo: knots taken, the curse, and the window. See combo.js. */
    this.combo = new ComboRun();

    this.grab = null;
    this.settle = null;
    this.pointer = { x: 0, y: 0 };
    this.stageInfo = null;

    /**
     * The CLEARED card's hold, or null whenever one is not up. It is the only thing left
     * between two stages, and when it runs out the next board is built and handed over.
     */
    this.interlude = null;
    /** The briefing on screen, by card name, or null. See BRIEFING in config.js. */
    this.briefing = null;
    /** Holds the card where it stands. Only ever set from the PAUSE button. */
    this.paused = false;
  }

  /**
   * The pooled par table as it stands right now.
   *
   * Read fresh on every stage load rather than captured once, because the pool hydrates
   * from localStorage before the first board and refreshes from the network some unknown
   * moment later. An empty object is the honest answer until then, and it means exactly
   * what it meant before the pool existed: nothing pooled, use your own times.
   */
  #pars() {
    return this.pool?.pars ?? {};
  }

  // --- lifecycle -------------------------------------------------------------

  /**
   * Builds a board and leaves it sitting in `intro`, untouchable.
   *
   * Deliberately does not decide what happens next: handing the board over is #enterStage's
   * job, and the solved path needs the board built *underneath* the card that is still
   * reporting the last stage. Every route in goes through #enterStage.
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
    this.combo.clear();

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
    this.frame = { width: this.width, height: this.height };
    this.fit = 1;

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
    // Null only for a stage nobody has ever cleared — the pool answers first and this
    // player's own history answers when it cannot. See deadline.js.
    this.clock.begin(stageDeadline(stage, this.progress.times, this.#pars()));
    this.tracker.collectPoints(this.knotMarkers);
    this.state = 'intro';
  }

  /**
   * Loads a stage and hands it straight over — through a briefing first, on the two stages
   * that have one to give.
   *
   * There is no count into a stage any more. The board is built and it is yours, which is
   * what makes a briefing legible as an exception rather than as more of the same.
   */
  #enterStage(stage, taunt = false) {
    this.loadStage(stage);

    const key = taunt ? BRIEFING.RIP_AND_TEAR : this.#unseenBriefing(stage);
    if (!key) {
      this.#beginPlay();
      return;
    }

    // Take the CLEARED card down first: the briefing is a second panel and they would
    // otherwise stack, the dead one behind the live one.
    this.#clearInterlude();

    // A card this config names and the markup does not have is nothing to read, so it is
    // nothing to wait for either — hand the board over rather than freezing it behind a
    // panel that never opened. The HUD is the only thing that knows, so it says.
    if (!this.hud.showBriefing(key, { stage, limit: this.clock.limit })) {
      this.#beginPlay();
      return;
    }

    this.briefing = key;
    // Remembered the moment it goes up rather than when it is dismissed. A briefing
    // reloaded past has been seen, and the alternative is a panel that reopens every time
    // somebody refreshes the tab on stage 1.
    if (key !== BRIEFING.RIP_AND_TEAR) {
      this.progress.briefed[key] = true;
      saveProgress(this.progress);
    }
  }

  /** The briefing this stage owes the player, or null — for a stage with none, or a seen one. */
  #unseenBriefing(stage) {
    const key = BRIEFING.STAGES[stage];
    return key && !this.progress.briefed[key] ? key : null;
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
   * point of the button, so it rides along to the briefing that answers for it.
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

  /** PAUSE, and the same button again to resume. Only the CLEARED hold can be held. */
  togglePause() {
    if (!this.interlude) return;
    this.paused = !this.paused;
    this.hud.setPaused(this.paused);
  }

  restart() {
    this.progress.total = 0;
    this.progress.maxStage = 1;
    this.progress.best = {};
    // Unlike the clear times below, the briefings go. "Back to stage 1" is somebody asking
    // to play the game from the beginning, and the beginning includes being told how it
    // works — it is also the only way back to a panel that is otherwise shown once ever.
    this.progress.briefed = {};
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
      // Fit the frame the board was generated in, and apply only the change from the fit
      // already applied. Scaling by the ratio of consecutive viewports instead loses a
      // little on every change and never gets it back: a phone rotated to landscape and
      // back sat at a fifth of its size, and every URL-bar collapse cost a few percent.
      if (!this.frame) this.frame = { width: this.width, height: this.height };
      const fit = Math.min(width / this.frame.width, height / this.frame.height);
      const scale = fit / this.fit;
      this.fit = fit;
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
      late: this.combo.running && this.combo.lapsed,
      created: this.tracker.createdSinceMark(),
      // The stage clock, judged at the same instant and for the same reason. A rope
      // released with a moment to spare has landed, and the settle running on past the
      // buzzer is the game's time, not the player's — so a drop that clears the board at
      // 0.1s left is a win even though it finishes resolving after zero.
      //
      // In practice this only ever latches false now, and that is the point rather than an
      // oversight: the buzzer ends the stage on the frame it goes, so there is no such
      // thing as a release made after it — #timeUp has already taken the rope out of the
      // player's hand. What is left here is the guarantee for the settle alone, stated
      // where the verdict is taken rather than assumed further down.
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
    const wasRunning = this.combo.running;

    for (const point of points) {
      const gained = this.score.addKnot(weight);
      this.combo.knot();
      // Once the run is a combo the score flies up into the total; before that there is no
      // total to fly into, so it just rises where it was earned.
      this.flashes.push({
        x: point.x,
        y: point.y,
        toX: this.width / 2,
        toY: COMBO_TOTAL_Y,
        fly: this.combo.chain >= COMBO.SHOW_FROM,
        text: `+${Math.round(gained)}`,
        life: FLASH_MS,
        total: FLASH_MS,
      });
    }

    // Opening it cold is refused inside the run itself: the multiplier acts on everything
    // accrued, so there has to be something to act on.
    this.combo.climb(curse, weight, wasRunning);
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
    const target = this.combo.curseTarget;
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

  /**
   * Runs the CLEARED card's hold down, and hands over the next stage when it is spent.
   *
   * The next board is built at the end rather than at the start, so the card is reporting
   * the stage behind it for the whole of its three seconds and the stage in front of it is
   * built once, on the way out — by whichever of this and playStage gets there first.
   */
  #updateInterlude(dt) {
    if (this.paused) return;

    this.interlude.remaining -= dt;
    if (this.interlude.remaining > 0) {
      this.hud.setCountdown(this.interlude.remaining / this.interlude.total);
      return;
    }

    this.hud.setCountdown(0);
    this.#enterStage(this.stage + 1);
  }

  /** Takes down whatever is between the stages. The board behind it is already built. */
  #clearInterlude() {
    this.interlude = null;
    this.paused = false;
    this.hud.setPaused(false);
    this.hud.hideInterlude();
  }

  /**
   * Hands the board over.
   *
   * Every route in ends here — a hold that ran out, a briefing dismissed, a stage entered
   * with neither — so there is no door into a live board that is narrower than the others.
   * `paused` is dropped rather than assumed clear because the hold can be sitting held when
   * the green button is pressed.
   */
  #beginPlay() {
    this.#clearInterlude();
    this.briefing = null;
    this.hud.hideBriefing();
    this.state = 'playing';
  }

  /**
   * The green button, and the Enter key: whatever is between the player and the board, this
   * is the way past it.
   *
   * A briefing simply goes away — the board behind it is loaded and waiting. The CLEARED
   * card is the one that carries work rather than only time: the next board is not built
   * until its hold ends, so cutting it short has to *do* that build rather than jump over
   * it, or the player is handed back the stage they just solved, already clear, with a
   * clock running on nothing to do. Everything that stage earned was banked before the card
   * ever went up, so nothing is lost by cutting it short.
   */
  playStage() {
    if (this.briefing) {
      this.#beginPlay();
      return;
    }
    if (!this.interlude) return;
    this.#enterStage(this.stage + 1);
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
    this.combo.fadePop(dt);
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
      // A rope already dropped is a landing #endGesture has not scored yet: it latched its
      // own verdict at the drop, and ending the stage from underneath it would take away a
      // move the player had already made. A rope still *in hand* is not that. It is a move
      // not yet made, the buzzer has gone, and the stage is over at the buzzer — waiting
      // for the drop would leave the clock reading zero while the board still answered to
      // the pointer, which is the one moment the readout must not be able to lie.
      if (this.clock.expired && !this.settle) this.#timeUp();
    }

    // The window runs in real time from the *priming* drop — while the player is thinking,
    // while they are holding a rope, and while it settles. Starting it only at x2 is what
    // made a double reachable at a stroll: the first link sat armed indefinitely, so any
    // second drop, whenever it came, opened the chain. The clock has to be running for the
    // starter itself, or the starter is not a starter.
    if (this.combo.running && this.state === 'playing') {
      const lapsed = this.combo.tick(dt);
      // Only an *idle* lapse cashes here. A rope already dropped is a landing #endGesture
      // has not scored yet — it latched its own verdict at the drop — and a rope still in
      // hand is a move not yet made. Cashing under either would kill a chain from behind.
      if (lapsed && !this.grab && !this.settle) this.#cashCombo(false);
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
      // At the cap, so anything this stage does not spend is thrown away on the way out.
      // Silent discarding would read as the carry being broken.
      bankFull: this.budget.bankFull,
      // Infinity on a stage with no record, which the readout shows as such. There is no
      // separate "untimed" flag to keep in step with the number.
      timeLeft: this.clock.remaining,
      // Projected, not banked: the pot is the player's, it is just not final yet.
      score: this.score.projected(this.combo.cursedMult),
      chain: this.combo.chain,
      cursedMult: this.combo.cursedMult,
      chainFraction: this.combo.fraction,
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
    // One call both snapshots and resets, so there is no window in which the run has been
    // paid out but its multiplier, target or half-finished jump are still live.
    const { rung, cursedMult, cursed: wasCursed } = this.combo.end();

    const cash = this.score.cashCombo(cursedMult, forfeited);
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
      const before = this.combo.cursedMult;
      this.#advance(this.#knotPoints(events), curse, weight);

      // A cursed combo carried to MAX blows the black rope off the board and banks a move.
      // Its freed knots are knots this drop took, so they join the same run — at flat
      // weight, since no rope was hauled to get them.
      if (before < COMBO.MAX && this.combo.cursedMult >= COMBO.MAX) {
        this.budget.grant(COMBO.REWARD_MOVES);
        this.hud.showBankDelta(COMBO.REWARD_MOVES);
        if (this.#detonateCursed()) {
          const freed = this.tracker.commit();
          events = events.concat(freed);
          this.#advance(this.#knotPoints(freed), -1, 1);
        }
      }

      // Reset on every knot, and measured from the drop that earned it.
      this.combo.refresh();
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
    // The clock outranks the board: whatever this drop just achieved, it achieved out of
    // time. Only a settle can get here with it set — a held rope never does, because the
    // buzzer ends the stage where it stands rather than waiting for the drop.
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

  /**
   * The clock ran out. The stage is over on that frame, whatever the player was doing.
   *
   * A rope in hand is abandoned where it stands rather than dropped: dropping it would run
   * it through #endGesture, which spends the move, starts a settle and scores whatever the
   * settle resolves — an untangle credited after the buzzer, paid for out of a budget the
   * stage no longer has. The gesture was never completed, so it is not charged and not
   * scored, and the rope simply stops where the clock caught it.
   *
   * Clearing `grab` is also what stops the board answering to the pointer: #updateDrag runs
   * off `grab` alone, so a held rope would otherwise stay draggable underneath the
   * game-over panel. The release that eventually arrives finds nothing held and does
   * nothing, which is the whole of the cleanup.
   */
  #timeUp() {
    this.grab = null;
    this.#endStage('gameover', 'time');
  }

  /**
   * The single way out of a stage, however it ended.
   *
   * A chain still running has to be paid out before the stage is scored, or the pot would
   * simply vanish — and that is as true of a stage lost to the clock as of one solved.
   *
   * The beat afterwards is not. `ending` holds the panel back so a combo callout can land
   * before it covers the board, and that is worth having on a stage the player won: the
   * winning move is very often the biggest combo of the stage. On a stage they lost it is
   * the game sitting on the verdict — a second of callout over a board that is already red,
   * already shaking and reading 0.0, while the one thing the player is waiting to be told
   * is whether it is over. It is over. Say so.
   */
  #endStage(finish, reason) {
    this.#cashCombo(false);
    this.state = 'ending';
    const holds = finish === 'solve' && this.banner;
    this.pending = { finish, reason, delay: holds ? BANNER_HOLD_MS : 0 };
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
   * scoreboard between every stage is a stop; a card carrying the two numbers worth
   * carrying is a beat, and the stage after this one is built the moment it ends.
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

    // Filed before anything else can touch the clock. The local record is still kept for
    // every clear: it is what the deadline falls back to with no network, and it is what
    // CLOCK.OWN_FLOOR reads to keep a pooled deadline from going tighter than this player's
    // own record says they need.
    const filed = recordClear(this.progress.times, this.stage, this.clock.elapsed);
    // Contributed to everyone else's par, and deliberately not awaited — this runs inside
    // scoring a solved stage, and the time affects the next player rather than this run.
    // The clamped number goes up rather than the raw one, so a stage left open while the
    // player answered the door is not what the pool learns from.
    this.pool?.submit(this.stage, filed);

    this.progress.best[key] = Math.max(previousBest, score);
    this.progress.maxStage = Math.max(this.progress.maxStage, this.stage);
    this.progress.total = Math.max(this.progress.total, runTotal);
    saveProgress(this.progress);

    this.paused = false;
    this.interlude = { remaining: INTERLUDE.CLEARED_MS, total: INTERLUDE.CLEARED_MS };
    // What the stage paid, and what the run is worth now. The two numbers the player
    // actually wants off a scoreboard, without the scoreboard.
    this.hud.showCleared({ stage: this.stage, score, total: runTotal });
    this.hud.setCountdown(1);
    this.hud.setPaused(false);
  }

  #gameOver(reason = 'moves') {
    this.state = 'gameover';
    this.hud.showGameOver({ stage: this.stage, knots: this.tracker.count, reason });
  }

  // --- render ----------------------------------------------------------------

  /**
   * How far into the endgame the clock is: 0 while there is time, 1 at the buzzer.
   *
   * Two ramps rather than one, because they say different things. `wash` opens at
   * PANIC_FROM and is a warning — there is still time to do something about it. `shake`
   * opens later, at SHAKE_FROM, and is not information at all; it is the end of the stage
   * felt rather than read.
   *
   * Both are gated on the stage actually being under way. The clock's fraction survives the
   * end of a stage — a board lost to it sits at exactly zero — and a game-over panel over a
   * board still shaking itself apart is the alarm outliving the emergency. `ending` counts
   * as under way: the outcome is decided but the board is still up, and cutting the alarm
   * out from under the callout would be a pop.
   *
   * An untimed stage pins the fraction at 1, so neither ever fires on one.
   *
   * Both ease out: most of the change is spent in the first moments past the threshold, and
   * the approach to full is slow. That is the shape that makes crossing a threshold an
   * event. A linear ramp announces nothing at the moment it opens — it is indistinguishable
   * from the frame before it for a good second either side, which on a threshold set at
   * PANIC_FROM is most of a stage spent not-quite-warning. Easing out spends the intensity
   * where the news is, and lets the tail be the long part.
   */
  #panic() {
    if (this.state !== 'playing' && this.state !== 'ending') return { wash: 0, shake: 0 };
    const left = this.clock.fraction;
    return {
      wash: easeOut(clamp((CLOCK.PANIC_FROM - left) / CLOCK.PANIC_FROM, 0, 1)),
      shake: easeOut(clamp((CLOCK.SHAKE_FROM - left) / CLOCK.SHAKE_FROM, 0, 1)),
    };
  }

  render(now) {
    const panic = this.#panic();
    this.renderer.draw({
      ropes: this.ropes,
      knots: this.knotMarkers,
      flashes: this.flashes,
      banner: this.banner,
      explosions: this.explosions,
      chain: this.combo.chain,
      cursedMult: this.combo.cursedMult,
      comboValue: this.score.comboValue(this.combo.cursedMult),
      comboShowFrom: COMBO.SHOW_FROM,
      // Cursed runs only — see comboName. Empty the rest of the time, which is what keeps
      // the normal indicator down to a knot count and a number.
      comboName: this.combo.cursed ? comboName(this.combo.cursedMult) : '',
      // 1 on the frame the multiplier climbed, easing to 0. The renderer owns the shape of
      // the jump; the game only says when it was struck.
      cursedPop: this.combo.pop,
      grabbedId: this.grab ? this.ropes[this.grab.ropeIndex].id : -1,
      // The endgame, as two intensities. The renderer owns what red looks like and how the
      // board shakes; the game only says how far gone the clock is.
      panic: panic.wash,
      shake: panic.shake,
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
      `combo x${this.combo.chain}${this.combo.cursed ? `  CURSED x${this.combo.cursedMult}` : ''}` +
        `  knots ${this.score.comboKnots}  accrued ${this.score.comboScore.toFixed(0)}  shown ${this.score.comboValue(this.combo.cursedMult).toFixed(0)}` +
        `  window ${this.combo.chainTimer.toFixed(0)}ms  burn x${this.combo.burnRate}`,
      // Spelled out end to end, because "where did that number come from" is the one
      // question a self-calibrating deadline has to be able to answer on demand.
      `clock ${(this.clock.elapsed / 1000).toFixed(1)}s / ` +
        (this.clock.timed ? `${(this.clock.limit / 1000).toFixed(1)}s` : 'untimed') +
        `  runs ${(this.progress.times[String(this.stage)] || []).length}` +
        ` -> counted ${runsCounted(this.stage, this.progress.times).length}` +
        ` (thin x${thinFor(runsCounted(this.stage, this.progress.times).length).toFixed(2)})` +
        `  own ${((expectedTime(this.stage, this.progress.times) || 0) / 1000).toFixed(1)}s` +
        `  target q${targetFor(this.stage).toFixed(2)}` +
        `  slack ${slackFor(this.stage).toFixed(2)}`,
      // Which population answered, now that two can. A deadline that feels wrong is the
      // first thing anyone will want to attribute, and "pooled or mine" is the first cut.
      `pool ${this.#pars()[String(this.stage)] ? `par ${(this.#pars()[String(this.stage)] / 1000).toFixed(1)}s` : 'no par'}` +
        ` (${Object.keys(this.#pars()).length} stages` +
        `${this.pool?.outbox.length ? `, ${this.pool.outbox.length} unsent` : ''})`,
      `state ${this.state}${this.grab ? '  grabbing' : ''}${this.settle ? '  settling' : ''}`,
    ].filter(Boolean);
  }
}

function midpointOf(rope) {
  return rope.nodes[(rope.nodes.length / 2) | 0];
}
