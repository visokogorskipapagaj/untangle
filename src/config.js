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

  KNOTS_BASE: 2,
  KNOTS_PER_STAGE: 1.6,

  /**
   * Late growth, on both counts at once.
   *
   * The early curves above pin at their caps — ropes at ROPES_MAX from stage 16, knots
   * at what that many ropes can hold from stage 21 — so without this every stage past 20
   * is the same size as the last and only the cursed ropes keep arriving. Past GROWTH_FROM
   * both grow by GROWTH_STEP every GROWTH_EVERY stages, compounded and spread *across*
   * those stages rather than stepped at the end of them: stage 21 is fractionally bigger
   * than 20, and stage 25 is a fifth bigger. Five flat stages and then a jump would read as
   * the difficulty stalling and then lurching.
   *
   * The ceilings are the hard stop, and they are about solvability rather than taste.
   * Ropes have to physically fit side by side for a board to be pullable apart at all, the
   * layout hill-climb costs roughly the square of the rope count, and a stage whose knots
   * outnumber what the move budget can ever cover is not a hard puzzle but an impossible
   * one. Both counts climb until they hit these and then hold.
   */
  GROWTH_FROM: 20,
  GROWTH_EVERY: 5,
  GROWTH_STEP: 0.2,
  ROPES_CEILING: 28,
  KNOTS_CEILING: 60,

  /**
   * Phones get a smaller board: past PHONE_FROM_ROPES the count is cut by PHONE_SCALE.
   *
   * A stage is laid out in viewport-relative units, so a 28-rope board technically *fits* a
   * phone — it is just unplayable. Ropes end up a finger-width apart with a finger on top
   * of them, and grabbing the one you meant stops being a decision and becomes a lottery.
   * Halving the count is the difference between a hard puzzle and a fiddly one. Knots come
   * down with it on their own, since the target is capped against the rope count.
   *
   * Phones only — not tablets, which have the room. PHONE_MAX_EDGE_PX is the shorter screen
   * edge in CSS px that separates the two: the largest phones are ~430, the smallest tablets
   * ~740.
   */
  PHONE_FROM_ROPES: 5,
  PHONE_SCALE: 0.5,
  PHONE_MAX_EDGE_PX: 480,

  /** Rope length as a fraction of the viewport diagonal; shrinks as ropes multiply. */
  LENGTH_BASE: 0.3,
  LENGTH_DECAY: 0.008,
  LENGTH_MIN: 0.16,

  /** Layout hill-climb budget when hitting the target knot count. */
  MAX_ITERATIONS: 600,
  MAX_LAYOUT_ATTEMPTS: 8,

  /** Keep ropes off the very edge (CSS px). */
  MARGIN: 34,

  /** Weights for the reported tangliness rating. */
  TANGLE_W_KNOTS: 1.0,
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
   * One extra move per this many knots; 0 disables the bonus.
   *
   * Off by default. A sensible player lands almost exactly on the cover — moving a rope
   * into free space clears every knot it had at once — so the cover is not a hard
   * floor but roughly what normal play achieves, and everything granted above it simply
   * banks. At one bonus per 4 knots a late stage got +5 moves on an ideal of 6,
   * roughly doubling the budget, and the bank ran away to ~45 over a 12-stage run.
   * Slack alone lands it near 14 and keeps banked moves scarce.
   */
  KNOTS_PER_BONUS: 0,

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
 * The only clean way out is a CURSED COMBO taken to x10, which detonates it for free.
 * Grabbing the black rope is not a shortcut to one — it is not in its own field, so it
 * links as an ordinary rung and cannot start or climb a cursed combo.
 *
 * Late stages carry several. The tax stays *flat* across them — a rope caught on two black
 * ropes costs double, not quadruple — because compounding it put ordinary ropes out of
 * reach of the whole move budget, which reads as a broken stage rather than a hard one. A
 * x10 detonates one rope: the one the run was last fed off. Clearing a board of four means
 * building four cursed combos, which is the intended late-game shape.
 */
export const CURSED = {
  /** First stage that carries one. */
  FROM: 16,

  /**
   * Past this stage, one more every EXTRA_EVERY stages: two from 21, three from 26, and so
   * on. MAX_SHARE is what stops that from eating the board — every cursed rope taxes
   * everything it touches and costs ten to grab, so a stage that is mostly black rope is
   * not a harder puzzle, it is an unplayable one. The ladder climbs until it hits the cap
   * and then holds there.
   */
  EXTRA_FROM: 20,
  EXTRA_EVERY: 5,
  MAX_SHARE: 0.3,

  /**
   * Grown longer than an ordinary rope, and seated on the board's most tangled ropes.
   *
   * Both are about the CURSED COMBO being reachable at all. The multiplier climbs only by
   * pulling ropes *out of* a curse's field, and each rope can be harvested once — parking
   * one back on the black rope is a fresh knot, which is a fumble that ends the run. So the
   * highest multiplier a stage can ever pay is fixed the moment it generates:
   *
   *   2 + (total weight of everything crossing a black rope - the lightest one's weight)
   *
   * Seated at random on a middling rope, that came to about 5 on the stages where the
   * cursed rope first appears — x10 was not hard there, it was arithmetically impossible,
   * and the detonation was dead content for the whole of its debut. A longer rope laid
   * across the busiest part of the board is what an obstacle that "poisons its neighbours"
   * is supposed to be, and it is what makes the payoff exist.
   */
  LENGTH_SCALE: 1.4,

  /** Moves consumed by grabbing one. */
  GRAB_COST: 10,
  /** Multiplier on any rope currently crossing one. Flat, however many it crosses. */
  DRAG_TAX: 2,
  WIDTH_SCALE: 2.2,
};

/**
 * Combo ladder — a running count of *knots*, not of moves.
 *
 * Every knot a clean drop takes off the board is a rung, and each one is worth
 * `KNOT_VALUE * rungMultiplier(rung)` the moment it lands: later knots in a run are worth
 * more than earlier ones. There is no ceiling on the rung. Keep unknotting inside the
 * window and it keeps climbing.
 *
 *   knot #1  ->  x1   scored, but not yet a combo — nothing is shown
 *   knot #2  ->  x2   the run becomes a combo
 *   knot #3  ->  x3   ...
 *
 * A drop only counts if it resolved something, parked nothing on another rope, and landed
 * inside the window. Miss any of the three and the run is over. One drop that rips three
 * knots apart is three rungs, because the combo counts knots.
 *
 * The window runs in *real time* from the priming drop — while the player is thinking,
 * while they are holding a rope, and while it settles. A clock that stopped whenever the
 * player was actually doing something meant the bar they were watching was not the
 * deadline they were racing, which is the one thing a visible timer must be.
 *
 * The deadline is judged against the *drop*, not against the settle that follows it. A
 * rope released with a tenth of a second to spare has landed; the 220ms of unscored
 * relaxation afterwards is the game's time, not the player's.
 */
export const COMBO = {
  /** Knots before the combo is a combo. One knot is an untangle, not a run. */
  SHOW_FROM: 2,
  /** Rung at which a cursed combo detonates the black rope and banks a move. */
  MAX: 10,
  /**
   * Rung past which the window stops tightening. A long run should be hard to *hold*, not
   * impossible to extend — without the flattening the pressure climbed forever and the
   * "no ceiling" on the rung was a ceiling in practice.
   */
  DECAY_FLOOR_RUNG: 10,

  /**
   * Time to land the next drop and keep the chain alive, measured from the drop before it.
   *
   * Each rung tightens it by WINDOW_DECAY, so a long chain gets progressively harder to
   * hold. At 300ms flat the chain died at 2 for any realistic reaction time — the window
   * has to clear a grab-to-grab reaction with room to spare before decay eats into it.
   */
  WINDOW_MS: 2000,
  WINDOW_DECAY: 0.97,
  WINDOW_MIN_MS: 600,

  /**
   * The combo is priced in *knots* — rope pairs actually pulled apart — not in gesture
   * precision. Precision is what the per-move score already measures; the combo measures
   * how much of the board you took apart while the clock was running.
   *
   *   each knot adds  KNOT_VALUE * rungMultiplier(rung) * the dragged rope's weight
   *   rungMultiplier(rung) = 1 + (rung - 1) * KNOT_MULT_STEP
   *
   * The weight is the rope's move cost, which is the thing its drawn thickness announces:
   * a knot taken off a triple rope pays three of one taken off a light one. A heavy rope
   * costs triple to shift, so pricing its knots flat made the ropes that are hardest to
   * work with the ones a run could least afford to touch.
   *
   * Accrued as it happens rather than multiplied at the end, so what the player watches
   * climb is the real number: the third knot of a run banks 125 * 1.23 = 154, and it does
   * so the moment it lands.
   */
  KNOT_VALUE: 125,
  KNOT_MULT_STEP: 0.115,

  /**
   * CURSED COMBO — a multiplier on the run, not a separate run.
   *
   * Unknot something off the curse's field — anything still crossing a black rope — while
   * a normal combo's decay is still going, and everything the run has accrued is multiplied
   * by the cursed rung. The rung starts neutral at 1 and every rope hauled out of a field
   * adds `cursedStep` — one for the haul plus the rope's own weight, the opener included.
   * It is uncapped, and the window burns down CURSED_BURN times as fast throughout.
   *
   * It cannot be started cold: with no run going there is nothing to multiply. Building a
   * normal run and then turning it onto the curse is the whole strategy.
   */
  CURSED_BASE: 2,
  /**
   * How much faster the window burns while the curse is on. At a flat double the run had
   * to be built at a sprint on top of already costing double to drag, which is pressure on
   * pressure; three-quarters again keeps it hurried without making it a reflex test.
   */
  CURSED_BURN: 1.75,

  /** Moves added to the bank when a cursed combo reaches MAX and detonates the rope. */
  REWARD_MOVES: 1,

  /**
   * The ladder's names, indexed by the *cursed multiplier* and shown on cursed runs only.
   *
   * A normal run is read by its knot count and its total, and nothing else: putting a name
   * on top of that meant every clean double shouted, and something that shouts every few
   * seconds is not a shout. A cursed run has earned the noise, so it gets the name — and
   * the name goes on the number that is actually doing something. The knot rung keeps
   * escalating what each knot is worth underneath, but while the curse is running it is
   * never *shown* as a multiplier: two `x` numbers side by side, one multiplying the pot
   * and one merely counting knots, read as the same kind of quantity and were not.
   *
   * That also lines the ladder up with the mechanic. The multiplier opens at CURSED_BASE
   * and MAX is where it detonates the rope, so the ladder is walked end to end exactly
   * once per cleared curse and tops out on the stage's biggest moment. It climbs by rope
   * weight and has no ceiling, so a triple can vault it past MAX — anything above the top
   * keeps the last name.
   */
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
   * Tightness: clearing a knot by a hair beats shoving ropes to opposite corners.
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
