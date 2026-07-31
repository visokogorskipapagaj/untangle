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
   *
   * Note that this is a *proportional* margin on a cover that grows all run: at 1.15 a
   * late stage handed out four spare moves a stage where an early one handed out one, so
   * the surplus arrived fastest exactly where the boards were supposed to bite. Trimmed
   * to 1.10, which is the same grant on small boards — ceil() swallows the difference
   * below about ten — and one move tighter on the large ones.
   */
  SLACK: 1.1,

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

  /**
   * Hard ceiling on banked moves. Spare moves above it are simply lost.
   *
   * The bank is meant to be a cushion, not savings. Left uncapped it compounds — a clean
   * run reached 37 by stage 20 and was still climbing, which is more spare moves than any
   * single stage costs, so the budget stopped being a constraint somewhere in the teens
   * and every stage after that was played with a net under it.
   *
   * A cap on its own would pin every player to the ceiling and make the readout say the
   * same thing about all of them; it is the tighter SLACK above that keeps the number
   * meaning something. Together a clean run sits at the cap, a slightly loose one hovers
   * near 3, and a wasteful one lives at zero — which is the bank reporting how the run is
   * actually going rather than how long it has been.
   */
  BANK_MAX: 6,

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
  /**
   * The lowest cursed multiplier that can exist, and therefore the first named rung.
   *
   * Not a threshold anyone chose — it is arithmetic. `#advance` opens the multiplier at
   * `1 + cursedStep(weight)`, and cursedStep is `1 + max(1, weight)`, so the smallest
   * value the game can ever produce is 3. This was 2 for a long time, which was harmless
   * in that `>= 2` and `>= 3` agree on every reachable value, but it described a rung that
   * could not happen and left NAMES[2] as content no player could ever see.
   *
   * Anything that changes cursedStep has to come back here.
   */
  CURSED_BASE: 3,
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
    // 0-2 are unreachable and stay in the array as blanks rather than being removed: the
    // list is indexed *by the multiplier*, so dropping a slot would slide every name down
    // one and quietly rename every rung above it. See CURSED_BASE for why 2 cannot happen.
    '',
    '',
    '',
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

/**
 * Where the combo indicator sits, in CSS px from the top of the viewport.
 *
 * Shared because the renderer and the game both need it and they need the *same* one: the
 * renderer draws the running total, and the game aims flying knot scores at it so they
 * land in the number they are filling.
 *
 * This used to be three literals in two files with an arithmetic relationship nothing
 * enforced — an origin and an offset in render.js, and a copy of their sum in game.js.
 * Moving either of the first two silently sent every knot score to a point the total was
 * no longer at, and nothing would have failed.
 */
export const COMBO_HUD = {
  /** The indicator's origin, which is also the label line. */
  ORIGIN_Y: 100,
  /** The running total, offset down from the origin. */
  TOTAL_DY: 28,
  /** The ladder name, under the total and on cursed runs only. */
  NAME_DY: 58,
  /** The payout banner that replaces the indicator when a run ends. */
  BANNER_Y: 118,
};

/** Absolute y of the running total: the one point knot scores fly into. Never hand-written. */
export const COMBO_TOTAL_Y = COMBO_HUD.ORIGIN_Y + COMBO_HUD.TOTAL_DY;

/**
 * The stage clock.
 *
 * There is deliberately no starting time in here, because there is no starting time. A
 * stage the player has never cleared runs *untimed* — the clock only measures it — and
 * every later attempt is given a deadline derived from what they actually did on it. The
 * game has no opinion about how long a board should take; it only has a record of how
 * long this player takes, so the pressure is calibrated to them rather than to a number
 * someone picked. See deadline.js for the model these knobs drive.
 */
export const CLOCK = {
  /**
   * Fraction thrown away from each end of a stage's samples before averaging. One run
   * interrupted by the doorbell and one lucky board are both spikes, and neither says
   * anything about how long the stage takes.
   *
   * Cutting the *fast* end matters as much as the slow one, and more so later: past par
   * the deadline walks down toward the quickest run on record, and a freak clear nobody
   * could repeat would otherwise become the permanent target.
   */
  TRIM: 0.1,

  /**
   * Samples kept per stage, oldest out first. The model is meant to track the player the
   * game currently has, not the one who fumbled through the stage a hundred runs ago — a
   * window that never forgets would hold the deadline open long after they outgrew it.
   *
   * It is also the length of the endgame: past par one more run is struck off the average
   * every stage, so a full window is a fifteen-stage runway before the deadline arrives at
   * the fastest run and stops.
   */
  KEEP: 20,

  /**
   * How far from the stage's own typical time a single new sample may sit before it is
   * pulled back in. A stage left open while the player answered the door is not a slow
   * clear, it is not a clear at all, and with few samples the trim cannot yet reject it.
   */
  OUTLIER: 4,

  /**
   * The pressure curve, in two halves that meet at exactly 1.0 — and the halves work by
   * different means, which is the point.
   *
   * Up to PAR_STAGE the deadline is the player's average plus a margin: SLACK_START at
   * stage 1, tapering to nothing. For most of that stretch the clock is a thing in the
   * corner they never have to think about.
   *
   * At PAR_STAGE the margin is gone and the deadline is the average itself. Past it the
   * margin cannot go negative — instead the *average* tightens, by striking the slowest
   * surviving run off it once per stage (see slowestStruck). The endgame therefore walks
   * from "your typical run" to "your best run" and stops there.
   *
   * That is why there is no floor in here. Every deadline the game ever sets is the mean
   * of times this player actually recorded on this stage, so the tightest one it can reach
   * is a single run they have already proved they can do. There is nothing to estimate and
   * nothing to guard against: the data cannot describe a stage nobody can clear.
   */
  SLACK_START: 1.4,
  PAR_STAGE: 30,

  /** Readout thresholds: amber, then red and counting in tenths. */
  WARN_MS: 10000,
  CRITICAL_MS: 5000,

  /**
   * The endgame, said by the board rather than by the readout.
   *
   * Everything above is in milliseconds, because a readout with five seconds on it means
   * the same thing on every stage. These are *fractions of the deadline*, because the board
   * turning red does not mean "five seconds" — it means "you are nearly out", and nearly
   * out of forty seconds and nearly out of three minutes are the same feeling and different
   * numbers. A stage nobody has ever cleared runs untimed, its fraction is pinned at 1, and
   * none of this ever fires on it.
   *
   * They are deliberately not the same threshold. The wash is a warning with time left to
   * act on it; the shake comes later and is not information so much as panic.
   */

  /**
   * Fraction of the deadline left at which the board starts going red.
   *
   * Nearly half the stage, which is a long warning — and it is meant to be. The ramp eases
   * out from here (see the endgame ramps in game.js), so the colour arrives decisively at
   * the threshold and then takes its time about the rest: the player is told they have
   * crossed into the endgame at the moment they cross, and the long tail afterwards is the
   * board getting quietly worse rather than the news being broken twice.
   */
  PANIC_FROM: 0.4,
  /**
   * How red it ever gets, at the very edge of the board and at zero on the clock. A quarter
   * is enough to change the colour of the room without touching the ropes' legibility —
   * this is a stage the player is still expected to clear, and they cannot clear what they
   * cannot see.
   */
  PANIC_ALPHA: 0.25,
  /**
   * The share of that reached in the middle of the board, where the ropes are. The wash is
   * one radial gradient over the one already there, and it runs the other way — weakest
   * where the work is, strongest at the edges, so the colour closes in rather than settling
   * on top of the puzzle.
   */
  PANIC_CORE: 0.32,

  /**
   * Fraction left at which the board itself starts shaking, and how far it goes, in px.
   *
   * Still well inside the wash, so the two arrive as two pieces of news rather than one:
   * the colour says the endgame has started, and the shake, later, says it is nearly over.
   * Close the gap between these and the second one stops meaning anything on its own.
   */
  SHAKE_FROM: 0.15,
  SHAKE_PX: 5,

  /**
   * Whether a stage nobody in the pool has ever cleared runs untimed.
   *
   * This used to be unconditional and per-player, and it was the rule that let a countdown
   * sit on a puzzle without ever timing somebody out of a board they had never seen. Once
   * the pool answers for a stage that protection is gone by construction: a new player's
   * very first board already has thousands of other people's times behind it. The rule
   * survives only for stages the pool itself has no record of.
   *
   * Set true to restore the old behaviour — your own first clear of each stage untimed,
   * pool or no pool.
   */
  UNTIMED_FIRST_CLEAR: false,

  /**
   * Never set a pooled deadline tighter than the player's own fastest clear of the stage.
   *
   * The model used to need no floor: every deadline was the mean of runs this player had
   * really completed, so the tightest one reachable was a time they had already proved. A
   * pooled mean can describe a stage this particular player cannot clear, and that is not
   * a hypothetical — it is what "calibrated to the playerbase" means for anybody below its
   * middle. This puts the old invariant back as an explicit guard rather than a property
   * of the data, and it can only ever loosen a deadline.
   *
   * It does nothing on a stage the player has never cleared, which is exactly the case it
   * cannot help with. Set false for an unguarded pool.
   */
  OWN_FLOOR: true,
};

/**
 * The shared pool.
 *
 * Times are aggregated across everyone who plays rather than kept to the device that
 * recorded them, so the pressure is calibrated to the playerbase. The client never blocks
 * on it: the whole par table arrives in one request at boot and is cached, so a stage load
 * is as synchronous as it ever was and a dead server is indistinguishable from a slow one
 * — both fall back to the player's own history.
 */
export const POOL = {
  /** Same origin by default. Point this at the API host to serve the game from a CDN. */
  BASE_URL: '',

  /** localStorage keys for the cached par table and the unsent-times outbox. */
  CACHE_KEY: 'untangle.pool.v1',
  OUTBOX_KEY: 'untangle.outbox.v1',

  /**
   * How long a cached par table is used before a refresh is attempted. The table only
   * moves as fast as the playerbase's aggregate does, which is to say barely — this is
   * about not hammering the server on every reload, not about freshness.
   */
  MAX_AGE_MS: 6 * 60 * 60 * 1000,

  /**
   * Unsent clear times held while offline, oldest dropped first.
   *
   * Bounded because this is a nicety: a player who plays a hundred stages on a plane
   * contributes the last few and no more. Losing the rest costs the pool nothing.
   */
  OUTBOX_MAX: 50,

  /** Give up on a request after this long and use what is cached. */
  TIMEOUT_MS: 5000,

  /**
   * Samples kept per stage on the server, oldest out first.
   *
   * Large enough that the trimmed mean is stable and the late-game percentile has real
   * runs behind it, small enough that the whole store stays a file worth rewriting. Note
   * this is the *pool's* window, not CLOCK.KEEP, which stays the per-player one.
   */
  SERVER_KEEP: 500,

  /** Stages the API will accept a time for at all. Anything else is a forged payload. */
  MAX_STAGE: 500,

  /**
   * Hard bounds on a submitted time, before any statistics see it.
   *
   * The trim and the clamp both need a plausible pool to work against, so they cannot be
   * what defends the pool when it is empty. These can: a stage cleared in under a second
   * did not happen, and one that took an hour was a tab left open.
   */
  MIN_MS: 1000,
  MAX_MS: 60 * 60 * 1000,

  /** Requests accepted per IP per window, and the window. Reads and writes share it. */
  RATE_LIMIT: 60,
  RATE_WINDOW_MS: 60 * 1000,

  /**
   * How long a client or proxy may reuse a par table, in seconds.
   *
   * The table moves at the speed of an aggregate over hundreds of runs, which is to say
   * barely, so this costs nothing in freshness and takes the repeated-read load off the
   * server entirely. It has to stay well under the client's own MAX_AGE_MS, which is the
   * real refresh interval — this only governs the hop in between.
   */
  PARS_MAX_AGE_S: 300,
};

/**
 * PostHog, which is two separate things wearing one name.
 *
 * The *capture* half runs in the browser on the project API key — the `phc_...` one, which
 * is public by design: it can write events and read nothing, which is why it is safe to
 * inline into the bundle and why Vite is allowed to do exactly that.
 *
 * The *stats* half runs on the server on a personal API key — the `phx_...` one, which can
 * read the whole project. It never goes near the client, and the endpoint below is what the
 * client gets instead: three numbers, already computed, with the key that produced them
 * still on this side of the wire. Anything that moves that key into `VITE_*` publishes it.
 */
export const ANALYTICS = {
  /**
   * Two hosts, because PostHog has two and they are not interchangeable.
   *
   * INGEST is where the browser posts events — `us.i.posthog.com`, the edge that exists to
   * swallow event volume. API is where the query endpoint lives — `us.posthog.com`, the
   * app itself. Pointing the reader at the ingest host is not a slow failure but a 404 on
   * a URL that looks entirely correct, which is why these are two constants and not one
   * with an `i.` somebody remembers to add.
   *
   * Both have an EU twin — `eu.i.posthog.com` and `eu.posthog.com` — and the region has to
   * match the key. A key used against the wrong region authenticates and then reports an
   * empty project, which reads as "no traffic yet" rather than as the misconfiguration it
   * is. Self-hosted is whatever the instance is on, for both.
   */
  DEFAULT_INGEST_HOST: 'https://us.i.posthog.com',
  DEFAULT_API_HOST: 'https://us.posthog.com',

  /**
   * How often the server re-asks PostHog for the three numbers.
   *
   * The floor is the rate limit: PostHog meters the query endpoint per team per hour, and
   * this fires three queries a tick, so a minute costs 180/hour against an allowance in the
   * low thousands. The ceiling is `currentVisitors`, which is the only one of the three that
   * moves on a human timescale — a minute-old count of who is playing right now is still
   * true enough to show, and an hour-old one is not.
   */
  REFRESH_MS: 60 * 1000,

  /** Give up on a query and keep the last known numbers. Generous: HogQL is not fast. */
  TIMEOUT_MS: 15000,

  /**
   * What "current" means, in minutes.
   *
   * Five, because that is the window PostHog's own web analytics calls "currently online",
   * and a number that disagrees with the dashboard it is supposed to mirror is a bug report
   * waiting to happen. Long enough that a player reading a briefing still counts; short
   * enough that it empties out when nobody is playing.
   */
  LIVE_WINDOW_MINUTES: 5,

  /**
   * How far back the average session runs, in days.
   *
   * Bounded rather than all-time, because an average over the life of the project is a
   * number that stops being able to move: a thousand old sessions drown whatever the last
   * week did, and the figure that is supposed to say "how long people play" says "how long
   * people played, mostly a while ago". Thirty days is a month of behaviour and nothing
   * older.
   */
  SESSION_WINDOW_DAYS: 30,

  /**
   * How long a client or proxy may reuse the numbers, in seconds.
   *
   * Deliberately the refresh interval and not longer: the server cannot answer with anything
   * newer than its own last refresh, so caching past it would hand out a number this process
   * has already replaced.
   */
  STATS_MAX_AGE_S: 60,
};

/**
 * Between stages.
 *
 * A stage does not end in a scoreboard, and the next one does not begin with a countdown.
 * It ends in a card that says you cleared it, which holds for a beat and then hands over
 * the board — the run keeps moving, and the only thing that stops it is the player deciding
 * to stop it. PAUSE is that decision, and it is the reason the card can be this pushy:
 * nothing is taken away from a player who wants a moment, it just is not the default.
 *
 * There used to be a count into every stage as well — a second card, a swipe between them,
 * and GO. It was a wait on the way into a board the player could already see, three times a
 * minute, and the one thing it protected against (a clock starting before anyone was
 * looking) is a thing the clock does not do anyway: it does not tick behind a panel.
 */
export const INTERLUDE = {
  /** How long the CLEARED card holds before the next board is handed over. */
  CLEARED_MS: 3000,

  /** Where "Rip & Tear" drops the player. */
  RIP_AND_TEAR_STAGE: 30,
};

/**
 * The briefings — the one thing that still opens a stage with a panel.
 *
 * A mechanic that can end a run without ever having been named gets exactly one modal, on
 * the stage it arrives, and never again. There are two, because there are two things the
 * board cannot say for itself: that a clock is running, and that the black rope is a
 * multiplier rather than only an obstacle.
 *
 * Keyed by the stage the thing *appears on* rather than the one before it — the cursed rope
 * is on the board behind the panel while you read about it, which is worth more than a
 * warning about something you cannot yet see.
 *
 * The values name a card in index.html, which is where the prose lives. Seen ones are
 * remembered in progress (`briefed`), so a briefing costs a player one dismissal for the
 * life of their record; `restart` is what puts them back.
 */
export const BRIEFING = {
  /** stage -> card. CURSED.FROM rather than a literal 16, so the two cannot drift apart. */
  STAGES: { 1: 'clock', [CURSED.FROM]: 'cursed' },

  /**
   * Rip & Tear's answer for itself. Deliberately outside STAGES and deliberately not
   * remembered: it is not an explanation, it is the button being rude back, and it belongs
   * to the button rather than to the stage it happens to drop you on.
   */
  RIP_AND_TEAR: 'riptear',
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
