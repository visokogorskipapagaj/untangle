/**
 * Every tunable in one place. Feel-tuning happens here, not in the modules.
 *
 * Distances suffixed `U` are in *normalized units*: pixels divided by the viewport
 * diagonal, so scoring is identical on a phone and a 32" monitor.
 */

export const ROPE = {
  /**
   * Reference node count. Ropes vary in size, and segment length is held constant
   * across them, so a rope's node count is derived from its length — a longer rope has
   * proportionally more nodes and therefore costs proportionally more travel to haul.
   */
  NODES: 24,
  /** Rope length as a multiple of the stage's base length. */
  SIZE_MIN: 0.6,
  SIZE_MAX: 1.55,
  NODES_MIN: 12,
  NODES_MAX: 42,
  /** Stroke width in CSS px. */
  WIDTH: 9,
  /** Jakobsen length-constraint passes applied on every drag frame. */
  DRAG_PASSES: 8,
  /** Passes per frame while a released rope settles. */
  SETTLE_PASSES: 4,
  /** How long the (unscored) post-release settle lasts, in ms. */
  SETTLE_MS: 220,
  /**
   * Laplacian smoothing per settle frame, eased out over the settle. Enough to erase
   * kinks; low enough that the rope does not visibly straighten itself.
   */
  SETTLE_SMOOTH: 0.15,

  /**
   * Drag falloff. Every node moves at least BASE of the pointer delta, which is what
   * makes a grab feel like picking the whole rope up rather than pinching it; nodes
   * within SPREAD of the grabbed node move more, up to the full delta.
   */
  DRAG_BASE: 0.55,
  DRAG_SPREAD: 0.6, // fraction of NODES

  /** Pointer must land this close (CSS px) to a rope to grab it. */
  GRAB_RADIUS_MOUSE: 22,
  GRAB_RADIUS_TOUCH: 30,
};

export const STAGE = {
  ROPES_BASE: 3,
  ROPES_PER_STAGE: 0.7,
  ROPES_MAX: 14,

  CROSSINGS_BASE: 2,
  CROSSINGS_PER_STAGE: 1.6,

  /** Rope length as a fraction of the viewport diagonal; shrinks as ropes multiply. */
  LENGTH_BASE: 0.3,
  LENGTH_DECAY: 0.008,
  LENGTH_MIN: 0.16,

  /** Layout hill-climb budget when hitting the target crossing count. */
  MAX_ITERATIONS: 600,
  MAX_LAYOUT_ATTEMPTS: 8,

  /** Keep ropes off the very edge (CSS px). */
  MARGIN: 34,

  /** Weights for the reported tangliness rating. */
  TANGLE_W_CROSSINGS: 1.0,
  TANGLE_W_ROPES: 0.35,
  TANGLE_W_PROXIMITY: 0.6,
};

/**
 * The move economy.
 *
 * Moves are a budget that counts down, not a tally that counts up. Each stage grants
 * `ideal + bonus` moves; whatever is left over banks and carries into the next stage.
 * Run out of both and the stage is lost.
 */
export const MOVES = {
  /**
   * `ideal` is the true minimum — the fewest ropes that must be relocated so nothing
   * crosses — scaled by this. At 1.0 par would be perfect play and the bonus moves
   * would be the player's entire margin for error.
   */
  SLACK: 1.15,

  /**
   * One extra move per this many crossings; 0 disables the bonus.
   *
   * Off by default. A sensible player lands almost exactly on the cover — moving a rope
   * into free space clears every crossing it had at once — so the cover is not a hard
   * floor but roughly what normal play achieves, and everything granted above it simply
   * banks. At one bonus per 4 crossings a late stage got +5 moves on an ideal of 6,
   * roughly doubling the budget, and the bank ran away to ~45 over a 12-stage run.
   * Slack alone lands it near 14 and keeps banked moves scarce.
   */
  CROSSINGS_PER_BONUS: 0,

  /** Backup moves a run starts with, so stage 1 is not a knife-edge. */
  STARTING_BANK: 3,

  /** Warn the player when the stage budget drops to this. */
  LOW_WARNING: 2,
};

/**
 * Heavy ropes. A thicker rope costs more than one move to drag, which turns the puzzle
 * from "which ropes must move" into "which ropes are worth moving" — the cheapest set of
 * ropes to relocate is no longer the smallest one.
 *
 * The stage budget accounts for this exactly: with weights in play the ideal is a
 * minimum *weighted* vertex cover, so a heavy rope makes stages harder by changing the
 * optimal solution, never by quietly underfunding the budget.
 */
export const HEAVY = {
  /** Stage at which double-cost ropes start appearing. */
  DOUBLE_FROM: 4,
  /** One additional double rope every this many stages after that. */
  DOUBLE_EVERY: 4,

  /** Stage at which a triple-cost rope becomes possible. */
  TRIPLE_FROM: 9,
  /** Per-stage chance that one shows up at all. */
  TRIPLE_CHANCE: 0.5,

  /** Heavy ropes never exceed this share of a stage. */
  MAX_SHARE: 0.4,

  /** Past this stage heavy ropes multiply and the share cap opens up. */
  LATE_FROM: 15,
  LATE_EVERY: 3,
  LATE_MAX_SHARE: 0.6,

  /** Stroke width multiplier per weight, so cost is legible before you grab. */
  WIDTH_SCALE: { 1: 1, 2: 1.75, 3: 2.5 },
};

/**
 * The cursed rope: black, with a red pulse crawling inside it.
 *
 * It is not a rope you are meant to move — grabbing it costs ten moves, which is nearly
 * always a run-ender. It is an obstacle to work *around*: any rope still crossing it
 * costs double to drag, so it poisons the ropes near it until you clear them off.
 *
 * The only clean way out is a x10 chain, which detonates it for free.
 */
export const CURSED = {
  /** First stage that carries one. */
  FROM: 16,
  /** Moves consumed by grabbing it. */
  GRAB_COST: 10,
  /** Multiplier on any rope currently crossing it. */
  DRAG_TAX: 2,
  WIDTH_SCALE: 2.2,
};

/**
 * Combo ladder — a skate-style chain, not a per-gesture count.
 *
 * Every consecutive move that untangles something links the chain. Let the window lapse
 * between moves, make a move that untangles nothing, or park a rope onto another, and
 * the chain drops to zero.
 *
 * The window only counts down while the player is *between* moves. Holding a rope or
 * waiting on its settle is being mid-trick; a drag that takes two seconds should not
 * break a chain that the player is actively landing.
 */
export const COMBO = {
  MAX: 10,
  /**
   * Time to land the next move and keep the chain alive, measured from the end of the
   * previous move's settle.
   *
   * Each rung tightens it by WINDOW_DECAY, so a long chain gets progressively harder to
   * hold. At 300ms flat the chain died at 2 for any realistic reaction time — the window
   * has to clear a grab-to-grab reaction with room to spare before decay eats into it.
   */
  WINDOW_MS: 650,
  WINDOW_DECAY: 0.99,
  WINDOW_MIN_MS: 300,
  /** Moves added to the bank each time the chain lands a full x10. */
  REWARD_MOVES: 1,
  NAMES: [
    '',
    '',
    'DOUBLE',
    'TRIPLE',
    'QUADRUPLE',
    'PENTAKILL!',
    'HOLY-SHIT!',
    'ARE YOU SERIOUS?!',
    'OUTRAGEOUS',
    'GODLIKE',
    'M-M-M-MONSTER DEKNOTTER',
  ],
};

export const SCORING = {
  /** Points a perfectly-played untangle is worth before modifiers. */
  BASE: 100,

  /**
   * Tightness: clearing a crossing by a hair beats shoving ropes to opposite corners.
   * tightness = clamp(GAP_REF_U / max(gap, GAP_FLOOR_U), 0, TIGHT_MAX)
   */
  GAP_REF_U: 0.06,
  GAP_FLOOR_U: 0.004,
  TIGHT_MAX: 4,

  /**
   * Efficiency: DRAG_REF_U / (DRAG_REF_U + dragCost). dragCost is summed node travel,
   * so a 24-node rope racks it up ~24x faster than a single point would.
   */
  DRAG_REF_U: 4.0,

  /** A gesture only counts as a move once it displaces this much summed travel. */
  MOVE_EPSILON_U: 0.002,
};

export const PALETTE = {
  /** Hue spread across the ropes at stage 1, in degrees. */
  SPREAD_START: 360,
  /** Per-stage multiplier — this is the "colours converge" difficulty knob. */
  SPREAD_DECAY: 0.88,
  /** Never collapse below this, or the stage becomes unreadable rather than hard. */
  SPREAD_MIN: 25,

  SAT: 74,
  LIGHT: 62,
  /** Lightness jitter also shrinks with the hue spread. */
  LIGHT_JITTER: 9,
};

/** CSS px -> centimetres. The CSS spec fixes 1in at 96px. */
export const PX_PER_CM = 96 / 2.54;
