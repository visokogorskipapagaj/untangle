import { COMBO, CURSED, ROPE } from './config.js';
import { generateStage, keepInside, playMargin } from './generator.js';
import { clamp, nearestOnPolyline } from './geometry.js';
import { MoveBudget } from './moves.js';
import { colorConvergence, stagePalette } from './palette.js';
import { saveProgress } from './progress.js';
import { makeRng, hashSeed } from './rng.js';
import { comboName, comboWindow, ScoreKeeper } from './scoring.js';
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

export class Game {
  constructor({ renderer, hud, progress, baseSeed, debug }) {
    this.renderer = renderer;
    this.hud = hud;
    this.progress = progress;
    this.baseSeed = baseSeed;
    this.debug = debug;

    this.state = 'title';
    this.stage = 1;
    this.width = 0;
    this.height = 0;
    this.margin = 0;

    this.ropes = [];
    this.tracker = null;
    this.score = new ScoreKeeper();
    this.budget = new MoveBudget();
    this.stageScores = new Map();
    this.crossingPoints = [];
    this.flashes = [];
    this.banner = null;
    this.pending = null;
    this.explosions = [];

    /** Consecutive moves that untangled something — the skate-style chain. */
    this.chain = 0;
    this.chainTimer = 0;
    this.cashBanner = false;
    this.lastMoveCost = 1;

    this.grab = null;
    this.settle = null;
    this.pointer = { x: 0, y: 0 };
    this.stageInfo = null;
  }

  // --- lifecycle -------------------------------------------------------------

  loadStage(stage) {
    this.stage = stage;
    this.hud.hideSolved();
    this.hud.hideGameOver();
    this.grab = null;
    this.settle = null;
    this.flashes.length = 0;
    this.explosions.length = 0;
    this.banner = null;
    this.pending = null;
    this.chain = 0;
    this.chainTimer = 0;
    this.cashBanner = false;
    this.lastMoveCost = 1;

    // A layout that generated with zero crossings would be solved on arrival; walk the
    // seed forward until we get a real puzzle.
    let info = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      info = generateStage(
        stage,
        this.width,
        this.height,
        hashSeed(this.baseSeed + attempt * 7919, stage),
      );
      if (info.crossings > 0) break;
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
    this.tracker.collectPoints(this.crossingPoints);
    this.state = 'playing';
  }

  /** Begins a fresh run: banked moves and accumulated score both start over. */
  start(stage = 1) {
    this.hud.hideTitle();
    this.stageScores.clear();
    this.budget.resetRun();
    this.loadStage(stage);
  }

  nextStage() {
    this.loadStage(this.stage + 1);
  }

  retryStage() {
    if (this.state === 'title') return;
    this.loadStage(this.stage);
  }

  /** Game over: the stage is replayable, but the bank is gone. */
  retryAfterGameOver() {
    this.budget.clearBank();
    this.loadStage(this.stage);
  }

  restart() {
    this.progress.total = 0;
    this.progress.maxStage = 1;
    this.progress.best = {};
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
   * Uniform scale about the centre: every crossing is preserved exactly, so resizing
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
      this.tracker.collectPoints(this.crossingPoints);
    }
  }

  // --- input -----------------------------------------------------------------

  onGrab(x, y, isTouch) {
    // Land any in-flight settle before deciding anything: it can be the thing that
    // clears the last crossing, and grabbing onto a stage that just ended would leave
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
    const { ropeIndex, cost } = this.grab;
    this.grab = null;

    // A tap that moved nothing is not a move. Letting it through would run a settle,
    // and settle motion can resolve crossings — handing out free untangles that cost
    // neither a move nor any travel.
    if (!this.score.endMove()) return;

    this.budget.spend(cost);
    // A rope's move cost is also what it contributes to the chain: hauling a double
    // rope advances two rungs, so the expensive ropes are the fast way up the ladder.
    this.lastMoveCost = cost;
    if (cost > 1) this.hud.showMoveDelta(-cost);
    // Touching the cursed rope should feel like a mistake you can physically feel.
    if (this.ropes[ropeIndex].cursed) this.hud.shudder();
    this.settle = { ropeIndex, remaining: ROPE.SETTLE_MS };
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

    const cursed = this.ropes.findIndex((r) => r.cursed && !r.removed);
    const taxed = cursed >= 0 && this.tracker.crossingsBetween(index, cursed) > 0;
    return rope.weight * (taxed ? CURSED.DRAG_TAX : 1);
  }

  /** Cost of the cheapest rope still on the board. */
  #cheapestMove() {
    let cheapest = Infinity;
    for (let i = 0; i < this.ropes.length; i++) {
      if (this.ropes[i].removed) continue;
      cheapest = Math.min(cheapest, this.#moveCost(i));
    }
    return cheapest === Infinity ? 1 : cheapest;
  }

  /**
   * Blows the cursed rope off the board, free of charge. It stays in the ropes array so
   * every pair index the tracker holds stays valid — it is simply no longer on the board.
   */
  #detonateCursed() {
    const index = this.ropes.findIndex((rope) => rope.cursed && !rope.removed);
    if (index < 0) return false;

    const rope = this.ropes[index];
    const mid = midpointOf(rope);
    rope.removed = true;
    rope.markDirty();
    this.tracker.recount(index);

    this.explosions.push({ x: mid.x, y: mid.y, life: 750, total: 750 });
    return true;
  }

  // --- simulation ------------------------------------------------------------

  update(dtMs, now) {
    const dt = Math.min(dtMs, MAX_DT);

    if (this.grab) this.#updateDrag();
    else if (this.settle) this.#updateSettle(dt);

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      this.flashes[i].life -= dt;
      if (this.flashes[i].life <= 0) this.flashes.splice(i, 1);
    }
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

    // The chain window only runs *between* moves. Holding a rope, or waiting on its
    // settle, is being mid-trick — a deliberate two-second drag must not break a chain
    // the player is actively landing.
    if (this.chain > 0 && !this.grab && !this.settle && this.state === 'playing') {
      this.chainTimer -= dt;
      // Letting the window lapse is a landing, not a bail — the pot banks at full value.
      if (this.chainTimer <= 0) this.#cashChain(false);
    }

    const crossings = this.tracker ? this.tracker.count : 0;

    this.hud.setStats({
      stage: this.stage,
      crossings,
      movesLeft: this.budget.stageLeft,
      bank: this.budget.bankLeft,
      // The alarm is about the *next* move, not the last one. Once the stage grant is
      // spent and knots are still on the board, every further move comes out of savings
      // — so the warning has to be up before the player commits to one, not after.
      drawingFromBank: this.budget.stageLeft === 0 && crossings > 0,
      distancePx: this.score.distancePx,
      score: this.score.score,
      chain: this.chain,
      chainFraction: this.chain > 0 ? this.chainTimer / comboWindow(this.chain) : 0,
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
    // crossings get counted against a shape it never really had. Walking the delta in
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
    this.tracker.collectPoints(this.crossingPoints);
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
    this.tracker.collectPoints(this.crossingPoints);

    this.settle.remaining -= dt;
    if (this.settle.remaining <= 0) this.#finishSettle();
  }

  #finishSettle() {
    if (!this.settle) return;
    this.settle = null;
    this.#endGesture();
  }

  /**
   * Ends the running chain and pays out its escrowed pot at the rung it reached.
   *
   * Every route out of a chain funnels through here — a fumble, a move that untangled
   * nothing, the window lapsing, and the stage ending — so the pot can never be stranded.
   */
  #cashChain(forfeited, rung = this.chain) {
    const cash = this.score.cashChain(rung, forfeited);
    this.chain = 0;
    this.chainTimer = 0;
    if (!cash) return null;

    const life = cash.forfeited ? KILLED_BANNER_MS : BANNER_MS;
    this.banner = {
      text: comboName(cash.rung),
      multiplier: `×${cash.rung}`,
      payout: `+${Math.round(cash.paid).toLocaleString()}`,
      killed: cash.forfeited,
      life,
      total: life,
    };
    // Tells #endGesture not to overwrite this with a per-move callout.
    this.cashBanner = true;
    return cash;
  }

  /**
   * One gesture, one evaluation. This is the only place points are awarded and the only
   * place the stage can end — which is what makes a move's value independent of frame
   * timing, and what stops a fast whip banking points on a separation that did not last.
   */
  #endGesture() {
    // Did this move put a fresh knot on the board? If so the chain is forfeit — you
    // untangled several ropes and then parked the one you were holding on another.
    const created = this.tracker.createdSinceMark();
    let events = this.tracker.commit();
    const resolved = events.reduce((sum, e) => sum + e.resolved, 0);

    const landed = resolved > 0 && created === 0;
    // The rung this move reaches. A move advances the chain by what the rope cost, so a
    // bail reports what it would have been and the killed callout can show the player
    // the chain they just dropped.
    const link = resolved > 0 ? this.chain + this.lastMoveCost : 0;

    // Because a heavy rope can vault several rungs at once, the reward fires on every
    // full x10 *crossed*, not on landing exactly on one.
    const rewards = landed
      ? Math.floor(link / COMBO.MAX) - Math.floor(this.chain / COMBO.MAX)
      : 0;
    if (rewards > 0) {
      this.budget.grant(COMBO.REWARD_MOVES * rewards);
      this.hud.showBankDelta(COMBO.REWARD_MOVES * rewards);
      // Detonating changes the board, so its freed crossings have to be committed too —
      // they belong to this move.
      if (this.#detonateCursed()) events = events.concat(this.tracker.commit());
    }

    const result = this.score.award(events, created > 0, Math.min(link, COMBO.MAX));
    this.tracker.collectPoints(this.crossingPoints);

    if (landed) {
      this.chain = link;
      this.chainTimer = comboWindow(link);
    } else {
      // The chain ends here. A fumble forfeits the multiplier; a move that simply
      // untangled nothing still banks the pot at the rung already reached.
      this.#cashChain(created > 0, Math.max(this.chain, link));
    }

    if (result) {
      for (const award of result.awards) {
        const a = midpointOf(this.ropes[award.i]);
        const b = midpointOf(this.ropes[award.j]);
        this.flashes.push({
          x: (a.x + b.x) / 2,
          y: (a.y + b.y) / 2,
          text: `+${Math.round(award.points)}`,
          life: FLASH_MS,
          total: FLASH_MS,
        });
      }
      // Only while the chain is still climbing. Once it ends, #cashChain has already put
      // up the payout callout, which is the one that matters.
      if (landed && result.combo > 1 && !this.cashBanner) {
        this.banner = {
          text: result.name,
          multiplier: `×${result.combo}`,
          killed: false,
          life: BANNER_MS,
          total: BANNER_MS,
        };
      }
    }
    this.cashBanner = false;

    // Out of moves is not only "zero left" — with heavy ropes on the board, being unable
    // to afford even the cheapest remaining rope is just as dead.
    const stuck = this.budget.totalLeft < this.#cheapestMove();
    const finish = this.tracker.count === 0 ? 'solve' : stuck ? 'gameover' : null;
    if (!finish) return;

    // A chain still running when the stage ends has to be paid out before the stage is
    // scored, or the pot would simply vanish.
    this.#cashChain(false, this.chain);

    // Let a combo callout land before the panel covers the board. `ending` freezes
    // input for that beat, so the stage cannot be touched while it plays out.
    this.state = 'ending';
    this.pending = { finish, delay: this.banner ? BANNER_HOLD_MS : 0 };
    if (this.pending.delay <= 0) this.#finishStage();
  }

  #finishStage() {
    const { finish } = this.pending;
    this.pending = null;
    if (finish === 'solve') this.#solveStage();
    else this.#gameOver();
  }

  #solveStage() {
    this.state = 'solved';

    const score = this.score.score;
    const carried = this.budget.settleStage();
    const key = String(this.stage);
    const previousBest = this.progress.best[key] || 0;

    this.stageScores.set(this.stage, score);
    const runTotal = [...this.stageScores.values()].reduce((sum, v) => sum + v, 0);

    this.progress.best[key] = Math.max(previousBest, score);
    this.progress.maxStage = Math.max(this.progress.maxStage, this.stage);
    this.progress.total = Math.max(this.progress.total, runTotal);
    saveProgress(this.progress);

    this.hud.showSolved({
      stage: this.stage,
      score,
      untangles: this.score.untangles,
      ideal: this.budget.ideal,
      bonus: this.budget.bonus,
      used: this.score.moves,
      carried,
      bank: this.budget.bank,
      bestCombo: this.score.bestCombo,
      distancePx: this.score.distancePx,
      avgTightness: this.score.avgTightness,
      avgEfficiency: this.score.avgEfficiency,
      best: previousBest,
      total: runTotal,
    });
  }

  #gameOver() {
    this.state = 'gameover';
    this.hud.showGameOver({ stage: this.stage, crossings: this.tracker.count });
  }

  // --- render ----------------------------------------------------------------

  render(now) {
    this.renderer.draw({
      ropes: this.ropes,
      crossings: this.crossingPoints,
      flashes: this.flashes,
      banner: this.banner,
      explosions: this.explosions,
      chain: this.chain,
      chainPot: this.score.pendingPoints,
      comboMax: COMBO.MAX,
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
      `stage ${this.stage}  ropes ${this.ropes.length}  crossings ${this.tracker ? this.tracker.count : 0}` +
        (info ? ` (target ${info.spec.targetCrossings})` : ''),
      info
        ? `cover ${info.moves.cover}  ideal ${info.moves.ideal}  bonus ${info.moves.bonus}  budget ${info.moves.budget}`
        : '',
      `moves used ${this.score.moves}  stage left ${this.budget.stageLeft}  bank ${this.budget.bankLeft}`,
      `nodes [${nodeCounts}]`,
      `weights [${weights}]  cheapest move ${this.#cheapestMove()}`,
      info
        ? `difficulty ${info.difficulty.toFixed(1)}  fits ${info.fits}  colour-converge ${(colorConvergence(this.stage, this.progress.options.distinct) * 100).toFixed(0)}%`
        : '',
      `travel ${this.score.distancePx.toFixed(0)}px  points ${this.score.points.toFixed(1)}  score ${this.score.score.toFixed(1)}  bestCombo x${this.score.bestCombo}`,
      `state ${this.state}${this.grab ? '  grabbing' : ''}${this.settle ? '  settling' : ''}`,
    ].filter(Boolean);
  }
}

function midpointOf(rope) {
  return rope.nodes[(rope.nodes.length / 2) | 0];
}
