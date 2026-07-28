# Untangle

Ropes drop into the viewport tangled. Pull them apart until nothing crosses.

Every stage grants a limited number of moves. Spend fewer than you're given and the rest
bank for later; run the stage grant *and* the bank dry without solving and the stage is
lost. Rip several crossings apart with one pull for a combo.

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
and the crossing tracker's farm-proof ratchet.

## Dev flags

| URL | Effect |
| --- | --- |
| `?debug=1` | Node dots, rope bounds, playfield margin, and a live readout of crossings / travel / score terms. Logs the run seed. |
| `?seed=123` | Fixes the run seed, so every stage generates identically. |
| `?stage=7` | Skips the title screen and loads straight into that stage. |

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

**Crossings** are counted per rope pair. Only one rope moves at a time, so only pairs
touching that rope are re-checked. Two hits merge into one crossing only if they are
*both* index-adjacent and in the same place: a polyline vertex landing on another line
registers one visual crossing as two or four hits, whereas a rope folded over another
produces index-adjacent hits at genuinely different points.

**Moves** are a budget, not a tally. A gesture drags one rope, ropes pass through each
other, and a rope can be relocated anywhere in one drag — so a rope moved into open space
crosses nothing, and the cheapest way to solve a stage is the cheapest set of ropes whose
removal leaves the rest crossing-free. That is exactly **minimum weighted vertex cover**
on the crossing graph (`src/solver.js`), computed exactly by branch-and-bound. The stage
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
before) now busts the budget on 8 of 60 stages, while a player who weighs crossings
against move cost never busts.

**The cursed rope** arrives at stage 16: black, with a red pulse breathing inside it.
Grabbing it costs ten moves, and any rope *currently* crossing it costs double to drag.
It is not a rope you are meant to move — it is an obstacle that poisons its neighbours
until you clear them off it, which is why the tax is dynamic: pulling ropes clear makes
the rest of the board cheaper. The clean way out is a ×10 chain, which detonates it free.
Moving it makes the whole view shudder.

Past stage 15 heavy ropes multiply and the share cap opens from 40% to 60%.

A rope you cannot afford refuses the grab rather than letting you commit to a drag that
ends the run on release, and the stage is lost when the cheapest rope left on the board
costs more than you have — not merely when the counter hits zero. A move's price is
locked in when you pick the rope up, so you pay what you agreed to.

Worth knowing if you retune it: a sensible player lands *almost exactly on the cover*,
because one drag into free space clears every crossing that rope had. The cover is not a
hard floor — it is roughly what normal play achieves — so every move granted above it
banks. That is why the crossing-count bonus is off by default; at one per four crossings
a late stage got +5 moves on an ideal of 6 and the bank ran to ~45 over a 12-stage run.

**Scoring** rewards precision over brute force:

```
tightness  = clamp(GAP_REF / max(gap, GAP_FLOOR), 0, TIGHT_MAX)
efficiency = DRAG_REF / (DRAG_REF + gestureCost)
pot       += BASE * tightness * efficiency        per crossing resolved
                                                  (escrowed, not banked)
on cash:  points += pot * min(rung reached, 10)
score      = points / max(1, moves)
```

**The combo is a chain, not a count.** Every consecutive move that untangles something
links it — one crossing cleared as the seventh link beats seven cleared cold. Let the
window lapse, make a move that untangles nothing, or park a rope onto another, and it
ends.

A move advances the chain by **what the rope cost**, so two double ropes take it 0 → 2 → 4
and the expensive ropes become the fast way up the ladder. Because a heavy rope can vault
several rungs at once, the ×10 reward — a banked move plus a free detonation of the cursed
rope — fires on every full threshold *crossed*, not on landing exactly on one. The
multiplier itself is capped at ×10, and the callout shows the capped value, so what the
player reads is what actually pays.

×1 is not a state: a single untangle is just a move. The chain meter — 75% of the screen,
centred under the HUD — appears at ×2 and collapses inward from both ends as the window
runs out, turning red and buzzing over the last 15%, when a colour change alone is too
easy to miss mid-drag.

**Points earned during a chain are held in escrow** and multiplied *once*, by the rung the
chain reached, when it cashes out — so the whole run is worth the rung it reached rather
than each move being worth whatever rung it happened to land on. Four links pay `pot × 4`,
not `1 + 2 + 3 + 4`. The running pot and what it would become are drawn under the chain
callout, because the stake growing is the entire tension.

Ending the chain by simply stopping is a *landing* and banks at full value; parking a rope
onto another one is a *bail* and pays the whole pot flat at ×1. That asymmetry is what
makes a long chain worth holding and a single fumble hurt. Every exit — a bail, a move
that untangled nothing, the window lapsing, the stage ending — funnels through one
`cashChain` call, so the pot can never be stranded.

The window starts at 450 ms and tightens 3% per rung (342 ms at ×10, floored at 200 ms).
It only counts down *between* moves — holding a rope or waiting on its settle is being
mid-trick, and a deliberate two-second drag must not break a chain you're landing. At a
flat 300 ms the chain died at 2 for any realistic reaction time: simulated against a
~450 ms grab-to-grab reaction, ×3 was reached 10 times in 20,000 and ×10 never.

Awards are evaluated **once per gesture**, never per frame. Per-frame awards paid out for
momentary separations mid-whip — a rope could end up more tangled and still bank points —
and made a gesture's value depend on where frame boundaries fell. One gesture is one move,
so one gesture gets one deterministic evaluation, priced against that gesture's whole cost.

Distance is the summed displacement of *every* node. It is normalized against the viewport
diagonal as it is banked — so a phone and a 32" monitor score the same play identically,
and a mid-stage resize cannot retroactively re-value work already done — and displayed in
real centimetres for flavour.

A pair only pays out when its crossing count drops below the lowest it has *ever* been,
so re-tangling two ropes and pulling them apart again earns nothing.

**Stages** are generated from a seed: ropes grow as random walks with angular momentum,
then a hill-climb nudges one rope at a time until the layout hits the target crossing
count. Difficulty ramps through rope count, crossing count, and rope colours that
converge toward each other — with an always-distinct-colours toggle in settings, since
otherwise the colour ramp locks colourblind players out of the later stages.

Every tunable lives in `src/config.js`.
