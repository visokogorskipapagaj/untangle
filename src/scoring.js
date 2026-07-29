import { COMBO, SCORING } from './config.js';
import { clamp } from './geometry.js';

/**
 * Scoring model.
 *
 * Two scores, deliberately measuring different things.
 *
 *   PRECISION, banked per gesture, chain or no chain:
 *     tightness  = clamp(GAP_REF / max(gap, GAP_FLOOR), 0, TIGHT_MAX)
 *     efficiency = DRAG_REF / (DRAG_REF + dragCost)
 *     points    += BASE * tightness * efficiency       per knot resolved
 *
 *   COMBO, accrued knot by knot while a run lasts, paid when it ends:
 *     accrued   += KNOT_VALUE * rungMultiplier(knots so far) * weight   per knot, as it lands
 *     points    += accrued * cursedMult
 *
 * Clearing a knot by a hair beats shoving ropes into opposite corners and clearing it
 * with a precise nudge beats flailing — that is what precision points price, and they land
 * immediately whether or not a chain is running. The combo prices something else entirely:
 * how much of the board you took apart while the clock was ticking, counted in knots. One
 * rewards care, the other rewards pace, and mixing them into a single number made each one
 * unreadable.
 *
 * Score is the raw point total, not a per-move average. Dividing by moves meant a chain
 * payout landed at a fraction of the number the callout had just promised, and then *fell*
 * with every move after it — points went up while the readout went down. Wasting moves is
 * already punished by the move budget, which ends the run outright; it does not also need
 * to retroactively devalue work the player has banked. The average survives as `perMove`
 * on the results panel, where it reads as the efficiency stat it always was.
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
    /** Best normal rung and best cursed multiplier landed this stage. */
    this.bestCombo = 1;
    this.bestCursed = 0;
    /** The running combo: knots taken so far, and what they have accrued. */
    this.comboKnots = 0;
    this.comboScore = 0;
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
   * Efficiency is priced against the gesture's *whole* cost, not a per-knot share of
   * it. Splitting the cost made a multi-clear cheaper per knot, which rewarded exactly
   * the same thing the combo already rewards — the two compounded and blew the scale out.
   * The combo is the multi-clear bonus; efficiency just measures how much rope the pull
   * cost.
   *
   * These points bank immediately, chain or no chain. They price the *care* in a gesture,
   * which the player earned whether or not a clock happened to be running; the combo is a
   * separate pot on top, priced in knots.
   */
  award(events) {
    if (!events.length) return null;

    const resolvedTotal = events.reduce((sum, e) => sum + e.resolved, 0);
    if (resolvedTotal <= 0) return null;

    const efficiency =
      SCORING.DRAG_REF_U / (SCORING.DRAG_REF_U + this.lastMoveDistanceU);

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
      this.points += points;
      this.untangles += event.resolved;
      this.tightnessSum += tightness * event.resolved;
      this.efficiencySum += efficiency * event.resolved;

      awards.push({ ...event, points, tightness, efficiency });
    }

    return { awards, resolved: resolvedTotal, points: gained };
  }

  /**
   * What one knot is worth at this rung. Later knots in a run are worth more than earlier
   * ones, which is what makes a long run worth holding.
   */
  rungMultiplier(rung) {
    return 1 + Math.max(0, (Math.round(rung) || 1) - 1) * COMBO.KNOT_MULT_STEP;
  }

  /**
   * Takes one knot off the board and into the running combo, returning what it was worth.
   *
   * Priced and added the instant it lands rather than tallied and multiplied at the end,
   * so the number the player watches climbing is the real one — and so each knot has a
   * value to float up into it.
   *
   * `weight` is the dragged rope's cost, which is exactly what its drawn thickness says:
   * a knot picked off a triple rope is worth three of one picked off a light one. A heavy
   * rope already costs three moves to shift, so without this the ropes that are hardest to
   * work with were also the ones a run could least afford to touch.
   */
  addKnot(weight = 1) {
    this.comboKnots += 1;
    const gained =
      COMBO.KNOT_VALUE * this.rungMultiplier(this.comboKnots) * Math.max(1, weight);
    this.comboScore += gained;
    return gained;
  }

  /** What the run is currently worth, with any cursed multiplier applied. */
  comboValue(cursedMult = 0) {
    if (this.comboKnots < COMBO.SHOW_FROM) return 0;
    return this.comboScore * Math.max(1, cursedMult);
  }

  /**
   * Ends a run and banks it.
   *
   * `forfeited` is a bail — the player parked a rope onto another one — and strips the
   * cursed multiplier, paying only what the knots accrued. Letting the window lapse is a
   * landing, not a bail: the run banks in full. That asymmetry is the whole tension, since
   * turning a long run onto the curse multiplies a number a single fumble flattens.
   *
   * A lone knot is not a run and pays nothing — the gesture that took it already banked
   * its precision points, and paying a one-knot "combo" would make the count meaningless.
   */
  cashCombo(cursedMult = 0, forfeited = false) {
    const knots = this.comboKnots;
    const accrued = this.comboScore;
    this.comboKnots = 0;
    this.comboScore = 0;
    if (knots < COMBO.SHOW_FROM) return null;

    const cursed = forfeited ? 1 : Math.max(1, cursedMult);
    const paid = accrued * cursed;
    this.points += paid;

    if (!forfeited) {
      if (knots > this.bestCombo) this.bestCombo = knots;
      if (cursed > this.bestCursed) this.bestCursed = cursed;
    }

    return { knots, accrued, cursed, paid, forfeited };
  }

  get score() {
    return this.points;
  }

  /** Points per gesture — how economically the stage was played, not what it was worth. */
  get perMove() {
    return this.points / Math.max(1, this.moves);
  }

  /**
   * What the score reads *right now*: banked points, plus what the running chain would pay
   * if it landed here.
   *
   * The pot is the player's — it is simply not final yet. Reading a flat banked total
   * while a chain ran left the score frozen through the best play in the game and then
   * jumping by a number that had been sitting in escrow all along. Projecting it means the
   * readout climbs with every link, the cash-out is a no-op, and a bail is visible as
   * exactly what it is: the score collapsing back to what was already banked.
   */
  projected(cursedMult = 0) {
    return this.points + this.comboValue(cursedMult);
  }

  get avgTightness() {
    return this.untangles ? this.tightnessSum / this.untangles : 0;
  }

  get avgEfficiency() {
    return this.untangles ? this.efficiencySum / this.untangles : 0;
  }
}

/**
 * The ladder name for a *cursed* multiplier — `×4` is `QUADRUPLE`, `×10` is the top of the
 * ladder, which is also the rung that detonates the rope.
 *
 * The names belong to the curse and nothing else. They used to name the knot rung, which
 * put two `×` numbers on a cursed callout eight pixels apart — one that multiplied the pot
 * and one that only counted knots — and made them look like the same kind of quantity. The
 * knot rung is a count, so it is shown as a count or not at all; the cursed multiplier is
 * the number that actually multiplies, so it is the one worth naming.
 *
 * The multiplier has no ceiling — it climbs by the weight of each rope pulled off the curse
 * and a triple can vault it past MAX — so anything above the top of the ladder keeps the
 * last name.
 */
export function comboName(cursedMult) {
  return COMBO.NAMES[Math.min(cursedMult, COMBO.MAX)] || '';
}

/**
 * What one haul out of a curse's field is worth to the cursed multiplier: one for the haul
 * itself, plus the rope's own weight.
 *
 * The multiplier starts neutral at 1, so the rope that *opens* the combo is worth exactly
 * what every rope after it is worth — it used to open at a flat x2 and throw its weight
 * away, which made hauling a triple off the curse first strictly worse than hauling it
 * second, for no reason a player could see.
 *
 * The `+1` is what makes the mechanic reachable. A curse's field is a shrinking pool —
 * every rope in it can be harvested once, since putting one back is a fresh knot and a
 * fumble — so the ceiling on a stage is fixed at generation time. Paying only the weight
 * meant a debut stage topped out around x5 against a x10 detonation.
 */
export function cursedStep(weight = 1) {
  return 1 + Math.max(1, weight);
}

/**
 * How long the player has to land the next move and keep a chain of this length alive.
 * Every rung tightens the window, so holding a long chain gets progressively harder.
 */
export function comboWindow(chain) {
  // Flat past DECAY_FLOOR_RUNG. The rung itself has no ceiling, so letting the window keep
  // tightening forever would have put one back in by the side door.
  const rungs = Math.max(0, Math.min(chain, COMBO.DECAY_FLOOR_RUNG) - 1);
  return Math.max(COMBO.WINDOW_MIN_MS, COMBO.WINDOW_MS * COMBO.WINDOW_DECAY ** rungs);
}

export function formatScore(value) {
  return Math.round(value).toLocaleString();
}
