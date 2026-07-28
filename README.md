# Untangle

Ropes drop into the viewport tangled. Pull them apart until nothing crosses.

Every stage grants a limited number of moves. Spend fewer than you're given and the rest
bank for later; run the stage grant *and* the bank dry without solving and the stage is
lost. Rip several knots apart with one pull for a combo.

Vanilla JS, Canvas 2D, native ES modules. No dependencies, no build step.

## Run

```bash
python3 -m http.server 8000   # or: npm start
```

Then open <http://localhost:8000>.

## Test

```bash
node --test test/*.test.js    # or: npm test
```

Covers the geometry primitives everything else is built on (segment intersection,
segment-to-segment distance, crossing detection and its de-duplication rules), the
minimum-vertex-cover solver that sets each stage's move budget, the move/bank economy,
and the knot tracker's farm-proof ratchet.

## Dev flags

| URL | Effect |
| --- | --- |
| `?debug=1` | Node dots, rope bounds, playfield margin, and a live readout of knots / travel / score terms. Logs the run seed. |
| `?seed=123` | Fixes the run seed, so every stage generates identically. |
| `?stage=7` | Skips the title screen and loads straight into that stage. |
| `?phone=1` | Forces the phone board (half the ropes) on or off, without a phone. |

`?seed=123&stage=7&debug=1` reproduces one exact layout, every time.

## How it works

**Ropes** are node chains with a fixed segment length; ropes vary in size, and because
segment length is held constant across a stage, a longer rope simply has more nodes — so
hauling it costs proportionally more travel. Dragging is *kinematic*, not simulated: the
pointer delta is applied to every node with a falloff around the grabbed one, then
Jakobsen relaxation restores segment lengths with the grabbed node pinned. Large deltas
are walked in segment-sized substeps so a fast flick cannot out-run the constraint solver.
The same drag always produces the same shape. The only motion a rope makes on its own is
a short settle after release, and that motion is never scored — a gesture that displaces
nothing is not a move at all, and doesn't even settle.

**Knots** are counted per rope pair. Only one rope moves at a time, so only pairs
touching that rope are re-checked. Two hits merge into one knot only if they are
*both* index-adjacent and in the same place: a polyline vertex landing on another line
registers one visual knot as two or four hits, whereas a rope folded over another
produces index-adjacent hits at genuinely different points.

**Moves** are a budget, not a tally. A gesture drags one rope, ropes pass through each
other, and a rope can be relocated anywhere in one drag — so a rope moved into open space
crosses nothing, and the cheapest way to solve a stage is the cheapest set of ropes whose
removal leaves the rest crossing-free. That is exactly **minimum weighted vertex cover**
on the knot graph (`src/solver.js`), computed exactly by branch-and-bound. The stage
grants `ceil(cover × SLACK)`; whatever is unspent banks.

**Heavy ropes** are drawn thicker and cost 2 (or later, 3) moves to drag. Doubles start
at stage 4, a triple becomes possible from stage 9, and they never exceed 40% of a stage.
Weight is assigned after the layout settles and only to ropes that actually cross
something, drawn from the more tangled half — a heavy rope in an empty corner would be
decoration rather than a decision.

This is why the cover is *weighted*: with weights in play the cheapest set of ropes to
move is often larger than the smallest set, so the budget stays honest instead of
quietly underfunding exactly the stages meant to be hardest. It also creates the skill
gap — measured against a greedy solver, grabbing the most-tangled rope (always correct
before) now busts the budget on 8 of 60 stages, while a player who weighs knots
against move cost never busts.

**The cursed rope** arrives at stage 16: black, with a red pulse breathing inside it.
Grabbing it costs ten moves, and any rope *currently* crossing it costs double to drag.
It is not a rope you are meant to move — it is an obstacle that poisons its neighbours
until you clear them off it, which is why the tax is dynamic: pulling ropes clear makes
the rest of the board cheaper. The clean way out is a CURSED COMBO taken to ×10, which
detonates it free — and grabbing the black rope is not a shortcut to one, because it is not
in its own field: it links as one ordinary rung and can neither start nor climb a cursed
combo. Moving it makes the whole view shudder.

**Past stage 20 they multiply**, one more every five stages: two from 21, three from 26,
four from 31. The count is capped at 30% of the ropes on the board — every black rope taxes
what it touches and costs ten to grab, and a stage that is mostly black rope is not a harder
puzzle, just an unplayable one. Since the board grows past stage 20 the cap lifts with it,
so the ladder runs unobstructed to eight at stage 51 and holds there.

The tax stays **flat** across them: a rope caught on two black ropes costs double, not
quadruple. Compounding reads as fair and plays as broken — between three curses an ordinary
rope would cost eight moves, more than the whole stage grant, to move one rope one time.

A ×10 detonates **one** rope: the one the run was last fed on. Clearing a board of four
means building four cursed combos, which is the shape the late game is meant to have. The
target is tracked per run — the payoff has to land on the rope the player was actually
farming, not on whichever one happens to sit first in the array while a different one
explodes across the screen.

Past stage 15 heavy ropes multiply and the share cap opens from 40% to 60%.

A rope you cannot afford refuses the grab rather than letting you commit to a drag that
ends the run on release, and the stage is lost when the cheapest rope *still knotted* costs
more than you have — not merely when the counter hits zero. Knotted is the operative word:
counting every rope on the board meant some rope lying clear in a corner read as an
affordable move, so a board where every knot cost more than you had left still reported as
playable while the grab was refused on everything that mattered. That is a deadlock, not a
reprieve. Either rope in a knot clears it, so a knot is only unaffordable when *both*
its ends are — one move left against a double knotted to a single is still winnable, and
against two doubles it is not. A move's price is locked in when you pick the rope up, so
you pay what you agreed to.

Worth knowing if you retune it: a sensible player lands *almost exactly on the cover*,
because one drag into free space clears every knot that rope had. The cover is not a
hard floor — it is roughly what normal play achieves — so every move granted above it
banks. That is why the knot-count bonus is off by default; at one per four knots
a late stage got +5 moves on an ideal of 6 and the bank ran to ~45 over a 12-stage run.

**Scoring** is two purses, measuring two different things.

```
PRECISION — banked per gesture, chain or no chain:
  tightness  = clamp(GAP_REF / max(gap, GAP_FLOOR), 0, TIGHT_MAX)
  efficiency = DRAG_REF / (DRAG_REF + gestureCost)
  points    += BASE * tightness * efficiency         per knot resolved

COMBO — accrued knot by knot while a run lasts, paid when it ends:
  accrued   += KNOT_VALUE * (1 + (knots so far - 1) * KNOT_MULT_STEP) * weight   per knot
  points    += accrued * cursedMult

score        = points        (per-move average kept as a results-panel stat)
```

Precision prices the *care* in a gesture — clearing a knot by a hair beats shoving
ropes into opposite corners, a precise nudge beats flailing — and it lands immediately
whether or not a clock is running. The combo prices something else: how much of the board
you took apart while the clock *was* running, counted in knots. One rewards care, the other
rewards pace. Folding them into a single escrowed number made both unreadable.

Score is the **raw point total**. Dividing it by moves meant a chain payout landed at a
fraction of the number the callout had just promised — a ×5 worth 4,762 moved the readout
by 952 — and then *fell* with every move after it, so points went up while the score went
down. Wasting moves is already punished by the move budget, which ends the run outright.

**The combo counts knots.** Every knot a clean drop takes off the board is a rung, worth
`KNOT_VALUE * rungMultiplier(rung)` the moment it lands — so later knots in a run are worth
more than earlier ones, and one pull that rips three knots apart is three rungs, not one.
There is no ceiling. Keep unknotting inside the window and it keeps climbing.

```
knot #1  ->  x1   scored, but not a run yet — nothing is shown, nothing is owed
knot #2  ->  x2   now it is a combo
knot #3  ->  x3   ...
```

The clock starts at the *first* knot. It used to start at ×2, which left the first one armed
indefinitely: any second drop, whenever it came, was a double. A drop only counts if it
resolved something, parked nothing on another rope, and landed inside the window; miss any
of the three and the run is over. A run that never reached two knots pays nothing at all —
its knots are dropped rather than paid flat, since the gesture already banked its precision
points.

**Rope weight prices the knot, not the rung.** A knot hauled off a triple rope is worth
three of one off a light rope — the thickness you can see is the multiplier — but it is
still one rung. Weight used to climb the *rung* instead, so a single triple rope opened a
chain at ×3 from cold and a following double landed it on ×5: no start, and a readout that
jumped and then appeared to fall when the next run began. Pricing rather than counting it
keeps the ladder honest while making the expensive ropes worth touching: a triple costs
three moves to shift, and paying flat for its knots made the hardest ropes on the board the
ones a run could least afford to go near.

The window opens at 2000 ms and tightens 3% per rung, **flattening at rung 10** (1521 ms,
and flat from there). Without the flattening the pressure climbed forever and the "no
ceiling" on the rung was a ceiling in practice.

It runs in **real time from the drop before it** — through the reach for the next rope and
through the haul itself, not just while you are thinking. That is why the number is not a
reaction time and cannot be read as one: a 500 ms haul spends a third of it before you have
decided anything. A window that stopped whenever the player was actually doing something
would mean the bar they were watching was not the deadline they were racing, which is the
one thing a visible timer must be.

**CURSED COMBO** — a multiplier on the run, not a separate run. Unknot something out of the
curse's field, while a run's decay is still going, and everything the run has accrued is
multiplied by the cursed rung. The rung starts neutral at 1 and **every rope hauled out of
a field adds one plus its weight** — the opener included, so hauling a triple off the curse
first is worth exactly what it is worth third. It is uncapped, and the window burns down 75%
faster the whole time.

It cannot be opened cold: with no run going there is nothing to multiply. Building a normal
run and then turning it onto the curse is the whole strategy.

**The field is a shrinking pool**, and that is the shape of the whole mechanic. Each rope in
it can be harvested once — putting one back on the black rope is a fresh knot, which is a
fumble that ends the run — so the highest multiplier a stage can ever pay is fixed the
moment it generates. That makes the ×10 detonation a property of the *board*, not of play:

> max = 1 + Σ (1 + weight) over every rope crossing a black rope

Seated at random on a middling rope and paying bare weight, that came to about ×5 on the
stages where the cursed rope debuts — the detonation was arithmetically impossible there,
not merely hard, for the whole five stages it existed alone. Three things fixed it: the
black ropes are **grown longer** than ordinary ropes, they are **seated on the hubs** (the
most-crossed ropes on the board, which is what an obstacle that "poisons its neighbours"
should be), and each haul pays one **plus** weight rather than weight alone. A guard-rail
test holds the line: across stages 16–40, at least 6 of every 12 seeds must be able to reach
×10 at all. It currently sits at 9 of 12 in the worst stage.

```
7 knots, ordinary        accrued  1,120
turn it onto the curse   CURSED x8   ->  1,120 x 8  =  8,960
```

The multiplier is a property of the run — ordinary knots after it still count, and it dies
only when the run does. Carried to ×10 it detonates the black rope the run was fed on and
banks a move, the only clean way off the board. A black rope is not in its own field or in
another's, so its knots count as ordinary rungs and can neither open nor climb the
multiplier.

**One combo indicator**, directly under the decay bar, and only ever one thing in it. While
a run is going it is the knot count and the running total; the instant the run ends, the
payout replaces it in the same place. An ordinary run says nothing else — no name, on the
indicator or on the payout: a name on every clean double meant the game shouted every few
seconds, and a shout that frequent is not a shout.

The ladder names (`DOUBLE`, `PENTAKILL!`, `GODLIKE`) belong to the **cursed** combo alone,
and they name the **cursed multiplier** — not the knot rung:

```
CURSED COMBO ×4        the multiplier, the only x-number on screen
    8,960              the pot it is multiplying
  QUADRUPLE            what ×4 is called
```

Naming the knot rung instead put two `×` numbers on the callout eight pixels apart — one
that multiplied the pot and one that only counted knots — which made them read as the same
kind of quantity. While the curse is running the knot rung keeps escalating what each knot
is worth underneath, but it is never *shown* as a multiplier. It also lines the ladder up
with the mechanic: the multiplier opens at ×2 and detonates the rope at ×10, so the ladder
is walked end to end exactly once per cleared curse and tops out on the stage's biggest
moment, which an uncapped knot rung never does cleanly.

Every time the multiplier climbs, the label and its name **jump** — a ballistic hop with a
punch of scale on the way up, landing exactly where they started. The climb is the reward,
and a number that changes in place is easy to miss under the shake and breathe the cursed
readout already carries. It fires on the climb and only on the climb: an ordinary knot taken
mid-curse pays and advances the rung, but the number the jump is about did not move, so the
readout holds still. The total never jumps with it — a knot score in flight is aimed at
where that number is *right now*.

Knot scores appear at the knot and then *fly up into the total* rather than rising and
fading, which is what makes the total read as something the player is filling.

That single slot is deliberate. There used to be a live callout that fired on landing a rung
*and* a payout banner in the middle of the screen, so landing a triple put "×3 TRIPLE" up
and then, a beat later, "×3 TRIPLE +461" — reading as landing the same triple twice.

The chain meter above it is the clock and only the clock. It is live from the first knot: a
running deadline the player cannot see is the one thing it exists to prevent. Thin and muted
before there is a combo, full height once there is, double height and blinking during a
cursed combo, red and buzzing over the last 15%.

Ending the run by simply stopping is a *landing* and banks in full; parking a rope onto
another one is a *bail* and strips the cursed multiplier, paying only what the knots
accrued. Every exit — a bail, a drop that untangled nothing, the window lapsing, the stage
ending — funnels through one `cashCombo` call, so the run can never be stranded.

The running total is **projected into the score readout**, so the readout climbs with every
knot, the cash-out is a no-op on screen, and a bail is visible as the score collapsing back
to the bare knots.

The window runs in **real time** from the first knot, and is reset by each one — not only
between moves. A clock that stopped whenever the player was actually doing something meant
the bar they were watching was not the deadline they were racing.

The deadline is judged against the **drop**, not against the settle that follows it. Both
verdicts — was it in time, and did it park a rope on another one — are latched at release
and handed to the evaluation 220 ms later. Without that, a continuously-running window kills
runs from behind: a rope released with a tenth of a second to spare is not judged until long
after the clock has run out, and a rope that drifts onto a neighbour during the game's own
unscored relaxation gets scored as the player having parked it there. A rope dropped late
but clean still ends the old run at the rung it reached — lapsing is a landing — and then
starts a new one with its own knots.

Awards are evaluated **once per gesture**, never per frame. Per-frame awards paid out for
momentary separations mid-whip — a rope could end up more tangled and still bank points —
and made a gesture's value depend on where frame boundaries fell. One gesture is one move,
so one gesture gets one deterministic evaluation, priced against that gesture's whole cost.

Distance is the summed displacement of *every* node. It is normalized against the viewport
diagonal as it is banked — so a phone and a 32" monitor score the same play identically,
and a mid-stage resize cannot retroactively re-value work already done — and displayed in
real centimetres for flavour.

A pair only pays out when its knot count drops below the lowest it has *ever* been,
so re-tangling two ropes and pulling them apart again earns nothing.

**Stages** are generated from a seed: ropes grow as random walks with angular momentum,
then a hill-climb nudges one rope at a time until the layout hits the target knot
count. Difficulty ramps through rope count, knot count, and rope colours that
converge toward each other — with an always-distinct-colours toggle in settings, since
otherwise the colour ramp locks colourblind players out of the later stages.

**Past stage 20 the board itself keeps growing.** The early curves pin at their caps —
ropes at 14 from stage 16, knots at what that many ropes can hold from stage 21 — so
without this every late stage is the same size as the last and only the cursed ropes keep
arriving. From stage 20 both counts grow **20% every five stages**, compounded and spread
*across* those stages rather than stepped at the end of them: stage 21 is fractionally
bigger than 20, stage 25 is a fifth bigger. Five flat stages and then a jump reads as the
difficulty stalling and then lurching.

| stage | 20 | 25 | 30 | 35 | 40 | 50+ |
| --- | --- | --- | --- | --- | --- | --- |
| ropes | 14 | 17 | 20 | 24 | 28 | 28 |
| knots | 34 | 41 | 49 | 59 | 60 | 60 |
| cursed | 1 | 2 | 3 | 4 | 5 | 7–8 |
| ropes (phone) | 7 | 9 | 10 | 12 | 14 | 14 |

Both counts stop at a hard ceiling — 28 ropes, 60 knots — and hold there. These are about
solvability, not taste: ropes have to physically fit side by side for a board to be
pullable apart at all, the layout hill-climb costs roughly the square of the rope count,
and a board whose knots outrun what any move budget can cover is not a hard stage but an
impossible one. Generation stays under ~20 ms and `fitsInViewport` holds at every stage
tested through 80.

**Phones play a half-size board.** Past 5 ropes the count is cut by half, and the knot
target follows on its own because it is capped against the rope count. A stage is laid out
in viewport-relative units, so a 28-rope board technically *fits* a phone — it is just
unplayable: the ropes end up a finger-width apart with a finger on top of them, and grabbing
the one you meant stops being a decision and becomes a lottery. Phones only, not tablets,
which have the room; the check is a coarse pointer **and** a screen whose shorter edge is
≤480 CSS px (the largest phones are ~430, the smallest tablets ~740). `?phone=1` forces it
on, `?phone=0` off, which is how it gets tested without a phone.

The knot curve is *held* at stage 20 and grown from there, rather than left to keep
climbing linearly underneath the growth — running both compounds two curves against each
other, and the count outruns what the ropes can hold within a few stages, at which point
the structural cap rather than the ramp is setting difficulty. Because the board grows, the
cursed cap (30% of the ropes) lifts with it: the one-per-five ladder runs unobstructed to
eight black ropes at stage 51.

Every tunable lives in `src/config.js`.
