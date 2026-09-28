# TODO

Open work, with enough context to pick up cold. Durable knowledge lives in `README.md`.

## Clock

- **Record time-outs as censored observations.** The pool only ever sees clears, so the
  quote can never observe how many attempts fail; the resting margin and the floor
  (`CLOCK.SLACK_END`, `CLOCK.FLOOR_MS`) are what stand in for that. Filing a time-out as
  "took longer than the deadline it was played against" would let the server estimate the
  real clear-time distribution (Kaplan-Meier) and quote a percentile of *attempts* rather
  than of clears. Needs a new `POST /api/times` shape, a second ring per stage in
  `server/store.js`, and the estimator in `src/deadline.js`. See README, "The stage clock".
- **The live pool is still the old model's data.** Every sample in `server/data/pool.json`
  was filed under the old ratcheting deadline, so the early stages hold two-second clears.
  The floor covers those; later stages re-settle on their own as the wider margin admits
  slower clears. Worth a look at `/api/pars` a week after deploying.

## UI

- **Enter on the game-over panel should retry.** The hotkey only knows the CLEARED card and
  the briefings (`Hud.#onKey` in `src/hud.ts`); a keyboard player has to Tab to the button.
- **`siteStats` is fetched and never shown.** `src/analytics.ts` keeps the three numbers
  on `globalThis.__stats`; nothing on the title screen reads them.

## Judgement calls from the review, not changed

- **Knots hauled off a black rope pay ten times.** The cursed rope's `weight` is
  `CURSED.GRAB_COST` (10) and that weight prices its knots in `ScoreKeeper.addKnot`, so a
  hub black rope hauled off six ropes accrues more than the README's x8 cursed-combo
  example. If the ten-move grab is meant to be the whole price, cap the weight used for
  knot value at the heavy-rope maximum in `Game.#advance`.
- **`MAX_DT` slows both clocks under 20 fps.** The 50 ms frame clamp in `Game.update`
  protects the settle from a backgrounded tab, but it also feeds the stage clock and the
  combo window, so a slow device files clear times shorter than they were. Feeding those
  two the unclamped delta fixes the bias but makes a backgrounded tab count against the
  clock, which is a design decision.

