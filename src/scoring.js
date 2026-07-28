import { COMBO, PX_PER_CM, SCORING } from './config.js';
import { clamp } from './geometry.js';

/**
 * Scoring model.
 *
 *   tightness  = clamp(GAP_REF / max(gap, GAP_FLOOR), 0, TIGHT_MAX)
 *   efficiency = DRAG_REF / (DRAG_REF + dragCost)
 *   combo      = min(crossings resolved by this one gesture, COMBO.MAX)
 *   points    += BASE * tightness * efficiency * combo   per crossing resolved
 *   score      = points / max(1, moves)
 *
 * Clearing a crossing by a hair beats shoving ropes into opposite corners; clearing it
 * with a precise nudge beats flailing; ripping several crossings apart in one pull beats
 * picking them off one at a time; and every extra gesture dilutes the total.
 *
 * Distances are normalized against the viewport diagonal *as they are banked*, not at
 * payout, so the same play scores the same on a phone and on a 32" monitor and a
 * mid-stage resize cannot retroactively re-value work already done. The metric readout
 * is converted back to real centimetres purely for flavour.
 */
export class ScoreKeeper {
  constructor() {
    this.beginStage(1000);
  }

  beginStage(diagonalPx) {
    this.diagonal = diagonalPx || 1000;
    this.moves = 0;
    this.untangles = 0;
    this.points = 0;
    this.distancePx = 0;
    this.distanceU = 0;
    this.tightnessSum = 0;
    this.efficiencySum = 0;
    this.bestCombo = 1;
    /** Raw points held in escrow by the running chain, multiplied when it cashes out. */
    this.pendingPoints = 0;
    this.moveDistancePx = 0;
    this.moveDistanceU = 0;
    this.lastMoveDistanceU = 0;
  }

  /** Only affects distance banked from here on; already-banked units are final. */
  setDiagonal(diagonalPx) {
    if (diagonalPx > 0) this.diagonal = diagonalPx;
  }

  beginMove() {
    this.moveDistancePx = 0;
    this.moveDistanceU = 0;
  }

  addDistance(px) {
    const u = px / this.diagonal;
    this.distancePx += px;
    this.moveDistancePx += px;
    this.distanceU += u;
    this.moveDistanceU += u;
  }

  /** Returns true if the gesture displaced enough to count as a move. */
  endMove() {
    this.lastMoveDistanceU = this.moveDistanceU;
    const counted = this.moveDistanceU > SCORING.MOVE_EPSILON_U;
    if (counted) this.moves++;
    return counted;
  }

  /**
   * Scores one completed gesture.
   *
   * Called once per move, never per frame. Evaluating per frame paid out for momentary
   * separations mid-whip and made a gesture's worth depend on where frame boundaries
   * landed; one gesture now gets exactly one deterministic evaluation, priced against
   * the distance that gesture actually cost.
   *
   * Efficiency is priced against the gesture's *whole* cost, not a per-crossing share of
   * it. Splitting the cost made a multi-clear cheaper per crossing, which rewarded
   * exactly the same thing the combo multiplier already rewards — the two compounded and
   * blew the scale out. The combo is the multi-clear bonus; efficiency just measures how
   * much rope the pull cost.
   */
  award(events, comboKilled = false, chain = 1) {
    if (!events.length) return null;

    const resolvedTotal = events.reduce((sum, e) => sum + e.resolved, 0);
    if (resolvedTotal <= 0) return null;

    const efficiency =
      SCORING.DRAG_REF_U / (SCORING.DRAG_REF_U + this.lastMoveDistanceU);

    // The rung this move reaches. It is *not* applied here — points earned during a
    // chain are held in escrow and multiplied once, when the chain cashes out, so the
    // whole run is worth the rung it reached rather than each move being worth the rung
    // it happened to land on.
    const combo = clamp(Math.round(chain) || 1, 1, COMBO.MAX);

    const awards = [];
    let gained = 0;

    for (const event of events) {
      // A null gap means the pair still crosses elsewhere, so there is no meaningful
      // clearance to measure yet — score it neutrally rather than as a perfect squeeze.
      const tightness =
        event.gap == null
          ? 1
          : clamp(
              SCORING.GAP_REF_U / Math.max(event.gap / this.diagonal, SCORING.GAP_FLOOR_U),
              0,
              SCORING.TIGHT_MAX,
            );

      const points = SCORING.BASE * tightness * efficiency * event.resolved;

      gained += points;
      this.pendingPoints += points;
      this.untangles += event.resolved;
      this.tightnessSum += tightness * event.resolved;
      this.efficiencySum += efficiency * event.resolved;

      awards.push({ ...event, points, tightness, efficiency });
    }

    // A killed combo never counts as the stage's best — it was not landed.
    if (!comboKilled && combo > this.bestCombo) this.bestCombo = combo;

    return {
      awards,
      combo,
      killed: comboKilled,
      name: comboName(combo),
      resolved: resolvedTotal,
      points: gained,
      pending: this.pendingPoints,
    };
  }

  /**
   * Ends a chain and pays out everything it accumulated, multiplied by the rung reached.
   *
   * `forfeited` is a bail — the player parked a rope onto another one — and pays the pot
   * flat. Simply letting the window lapse is a landing, not a bail: the run banks at full
   * value. That asymmetry is the whole tension of the chain, since every extra link
   * multiplies a pot that a single fumble drops to x1.
   */
  cashChain(rung, forfeited = false) {
    const pot = this.pendingPoints;
    this.pendingPoints = 0;
    if (pot <= 0) return null;

    const multiplier = forfeited ? 1 : clamp(Math.round(rung) || 1, 1, COMBO.MAX);
    const paid = pot * multiplier;
    this.points += paid;

    return { pot, rung: clamp(Math.round(rung) || 1, 1, COMBO.MAX), multiplier, paid, forfeited };
  }

  get score() {
    return this.points / Math.max(1, this.moves);
  }

  get avgTightness() {
    return this.untangles ? this.tightnessSum / this.untangles : 0;
  }

  get avgEfficiency() {
    return this.untangles ? this.efficiencySum / this.untangles : 0;
  }
}

export function comboName(combo) {
  return COMBO.NAMES[Math.min(combo, COMBO.MAX)] || '';
}

/**
 * How long the player has to land the next move and keep a chain of this length alive.
 * Every rung tightens the window, so holding a long chain gets progressively harder.
 */
export function comboWindow(chain) {
  const rungs = Math.max(0, chain - 1);
  return Math.max(COMBO.WINDOW_MIN_MS, COMBO.WINDOW_MS * COMBO.WINDOW_DECAY ** rungs);
}

/** Summed node travel in CSS px, rendered as real-world distance. */
export function formatDistance(px) {
  const cm = px / PX_PER_CM;
  if (cm < 100) return `${cm.toFixed(0)} cm`;
  if (cm < 100000) return `${(cm / 100).toFixed(2)} m`;
  return `${(cm / 100000).toFixed(2)} km`;
}

export function formatScore(value) {
  return Math.round(value).toLocaleString();
}
