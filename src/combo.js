import { COMBO } from './config.js';
import { comboWindow, cursedStep } from './scoring.js';

/**
 * The running combo, as a thing rather than as five fields.
 *
 * This is the *state machine*: how many knots the run has taken, whether the curse is on
 * and by how much, which black rope it is feeding on, and how long is left to land the
 * next drop. What a run is *worth* lives in ScoreKeeper, and the two are deliberately
 * separate — one is a clock and a couple of counters, the other is pricing.
 *
 * It was five loose fields on Game, mutated from eight different methods, with the rule
 * that every route out of a run has to pay it out first held together by a comment. The
 * invariant that matters is that `end()` is the only way any of it gets cleared, which is
 * a thing a class can actually enforce and a naming convention cannot.
 *
 * Nothing here knows about ropes, the board, or the renderer. It is driven entirely by
 * `tick`, `knot`, `climb` and `end`.
 */

/** How long the cursed readout's jump lasts each time the multiplier climbs. */
export const CURSED_POP_MS = 340;

export class ComboRun {
  constructor() {
    this.clear();
  }

  /**
   * Wipes the run without paying it out.
   *
   * For starting a stage, and for `end()` once it has taken its snapshot. Anything that
   * finishes a live run wants end() — clearing one that still had knots in it is exactly
   * how a pot gets stranded.
   */
  clear() {
    /** Knots taken so far: 0 nothing, 1 primed, >=2 a live combo. */
    this.chain = 0;
    /** 0 while normal; >=COMBO.CURSED_BASE once the curse has taken the run over. */
    this.cursedMult = 0;
    /** Which black rope the run is feeding on, and therefore which one a x10 blows. */
    this.curseTarget = -1;
    /** Counts down after each climb of the multiplier; drives the readout's jump. */
    this.cursedPop = 0;
    /** Time left to land the next drop. */
    this.chainTimer = 0;
  }

  /** A run exists from the first knot onward — that is when the clock starts. */
  get running() {
    return this.chain >= 1;
  }

  get cursed() {
    return this.cursedMult >= COMBO.CURSED_BASE;
  }

  /** How fast the window burns. A cursed combo doubles the reward and the pressure both. */
  get burnRate() {
    return this.cursed ? COMBO.CURSED_BURN : 1;
  }

  get lapsed() {
    return this.chainTimer <= 0;
  }

  /** 1 at the drop, 0 at the buzzer. What the decay bar draws. */
  get fraction() {
    return this.running ? this.chainTimer / comboWindow(this.chain) : 0;
  }

  /** 1 on the frame the multiplier climbed, easing to 0. */
  get pop() {
    return this.cursedPop / CURSED_POP_MS;
  }

  /** One knot onto the run. */
  knot() {
    this.chain += 1;
  }

  /** Restarts the window, measured from the drop that earned it. */
  refresh() {
    this.chainTimer = comboWindow(this.chain);
  }

  /** Burns the window down, and reports whether it has just run out. */
  tick(dt) {
    this.chainTimer = Math.max(0, this.chainTimer - dt * this.burnRate);
    return this.lapsed;
  }

  fadePop(dt) {
    if (this.cursedPop > 0) this.cursedPop = Math.max(0, this.cursedPop - dt);
  }

  /**
   * Opens or climbs the cursed multiplier, and reports whether it moved.
   *
   * `curse` is the black rope the drop was pulled off, or -1. `wasRunning` is whether a run
   * was already going *before* this drop's knots were counted — the multiplier acts on the
   * whole run, so there has to be a run to act on, and it cannot be started cold.
   *
   * Neutral at 1, so the rope that opens the multiplier is worth exactly what every rope
   * after it is worth — see cursedStep.
   */
  climb(curse, weight, wasRunning) {
    if (curse < 0) return false;
    if (!this.cursed && !wasRunning) return false;

    this.cursedMult = (this.cursed ? this.cursedMult : 1) + cursedStep(weight);
    this.curseTarget = curse;
    // The multiplier climbing *is* the reward, and a number that changes in place is easy
    // to miss underneath the shake the cursed readout already carries. Only set when the
    // multiplier moves — an ordinary knot mid-curse climbs the rung, not this.
    this.cursedPop = CURSED_POP_MS;
    return true;
  }

  /**
   * Ends the run, returning what it was for the payout to be priced against.
   *
   * The snapshot is taken before the reset because every caller needs both — what the run
   * had reached, and a clean slate for the next one. Splitting that into "read the fields,
   * then remember to clear them" is what left a jump mid-flight and a curse target alive
   * into the following run.
   */
  end() {
    const was = { rung: this.chain, cursedMult: this.cursedMult, cursed: this.cursed };
    this.clear();
    return was;
  }
}
