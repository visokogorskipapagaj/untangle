# Untangle

Ropes drop into the viewport tangled. Pull them apart until nothing crosses.

Every stage grants a limited number of moves. Spend fewer than you're given and the rest
bank for later; run the stage grant *and* the bank dry without solving and the stage is
lost. Rip several knots apart with one pull for a combo.

There is also a clock, and nobody picked its numbers: a stage's deadline is what clearing
it actually takes, pooled across everyone who plays, with progressively less of it handed
back as the stages get harder.

Canvas 2D for the board, native web components for everything around it. The simulation is
plain JavaScript; the interface is a folder per element, built with Vite.

## Run

```bash
npm start          # builds, then serves on :8000
```

Then open <http://localhost:8000>. That serves the built game *and* the pool API from one
dependency-free Node server; times are kept in `server/data/pool.json`.

```bash
npm run dev        # Vite dev server on :5173, with HMR
npm run serve      # serve an existing build, no rebuild
npm run build      # -> dist/
npm run typecheck
```

`npm run dev` proxies `/api` through to :8000, so run `npm run serve` alongside it if you
want the pool live while editing. Without it the game falls back to this device's own clear
times, which is also what happens whenever the API is unreachable — `?pool=0` forces that
path deliberately.

## Layout

```
index.html          a canvas and seven tags
src/
  main.ts           boot: renderer, input, the frame loop
  hud.ts            the one object the game talks to about the screen
  analytics.ts      PostHog capture, and the site numbers as a variable
  app.scss          the page, the playfield, the canvas
  *.js              the simulation — ropes, knots, solver, scoring, clock, pool
  ui/
    tokens.scss     the design system, and the only global styling
    base.ts         shadow root, adopted sheet, template
    shared/         Sass partials more than one component uses
    fonts/          the typeface, self-hosted, with its licence
    <component>/    <component>.html + .scss + .ts
server/
  index.js          the pool API, /api/stats, and the static server for dist/
  store.js          the pooled clear times
  stats.js          the PostHog reader behind /api/stats
```

Every element on screen is a component, and a component is three files named after its
folder: the markup, the sheet, and the class that joins them. Six of them are primitives
the rest compose — `overlay`, `panel`, `button`, `icon-button`, `toggle`, `stat`, plus an
`icon` catalogue — and seven are regions: `hud`, `chain-meter`, `title-screen`, `interlude`,
`briefing`, `game-over`, `settings`.

Each renders into its own shadow root and adopts its own constructed stylesheet, so no
component's CSS can land on another's markup. What still crosses the boundary is the design
system: custom properties inherit through shadow roots, so `tokens.scss` reaches everything
without being handed to anything. That is the whole arrangement — tokens are shared, rules
are not.

The typeface is the one asset. Bricolage Grotesque, a variable font, is self-hosted from
`src/ui/fonts` and declared in `tokens.scss`, because `@font-face` has to live in the
document to be usable from inside a shadow root. It sets every number and every headline,
on the canvas as well as in the HUD; prose stays on the system stack. It ships with the
game rather than being fetched from a font CDN, so an offline load looks the same as an
online one.

`hud.ts` is the seam. It finds the regions, forwards their events to handlers, owns the
page-wide hotkeys, and answers `anyOverlayOpen`; `game.js` calls `showCleared` and `setStats`
exactly as it always did and has no idea there are components behind them.

## Deploy

```bash
docker compose up -d --build
```

One container. The build runs in its own stage inside it, so there is nothing to remember
before `docker build` and the toolchain never reaches the runtime image. The pool is the
only state: it lives in the `untangle-pool` volume, and losing that resets everyone's stage
times. Nothing else needs backing up.

### Push to deploy

```
git push origin main
  -> typecheck, 345 tests                     (GitHub runner)
  -> build image, push to ghcr.io             (GitHub runner)
  -> back up the pool, pull, health-check     (the box)
```

Nothing is built on the box and nothing is copied to it — the image arriving from ghcr.io is
the deploy. Editing files in a folder there changes nothing.

`.github/workflows/ci.yml` runs all three. Every push and PR gets the first stage; only
`main` gets the other two, and each waits on the one before it, so an image in the registry
is one that passed and a deployed image is one that was published.

The last stage runs on a **self-hosted runner on the box**, which is what makes this work at
all: the box sits behind a Cloudflare tunnel and has no inbound route, so nothing can deploy
*into* it. A runner dials out. That also means no SSH key and no Access token in this
repository's secrets — publishing uses the built-in `GITHUB_TOKEN`, and the deploy end holds
no credential at all.

Do not put a self-hosted runner on a public repository. Any fork's pull request can execute
code on it.

The box needs Docker and a runner. Not Node, not npm, not a checkout of the source — the
image is already built and tested when it arrives. `compose.prod.yaml` is what runs there,
and it comes from the workflow's own checkout so it cannot drift from what is in git.

`deploy/deploy.sh` is the deploy: it copies `pool.json` out of the volume first, pulls, waits
for `/api/pars` to answer, and on a timeout puts the previous image back by id and exits
non-zero. Pooled times are the only state that cannot be regenerated — everything else in
the container is rebuilt from source on every deploy, and they are not. Backups land in
`~/untangle-backups`, twenty deep.

One property worth knowing: the store flushes on SIGTERM, so up to two seconds of times live
only in memory. `docker compose up -d` stops the old container gracefully, so a deploy keeps
them. A `docker kill` would not.

Behind an existing nginx, as a **subdomain** — nothing in the app needs changing:

```nginx
server {
    server_name untangle.example.com;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        # UNTANGLE_TRUST_PROXY=1 reads the entry this proxy appends. Without it every
        # player shares one rate-limit bucket, because every request arrives from the proxy.
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Under a **subpath** the client needs telling, because the page's assets are relative but
its API calls are not — `POOL.BASE_URL` is `''`, so it asks for `/api/pars` at the domain
root and gets somebody else's 404. Set `POOL.BASE_URL` in `src/config.js` to the same
prefix:

```nginx
location /untangle/ {
    proxy_pass http://127.0.0.1:8000/;   # the trailing slash strips the prefix
    # ...same proxy_set_header lines as above
}
```

```js
// src/config.js
BASE_URL: '/untangle',
```

Caddy would do the same job with less TLS configuration, but it is not worth swapping a
working nginx for: both want :80 and :443, so adding one means either migrating every
other service or chaining the two, and this is one `location` block either way.

## Test

```bash
npm test
```

Still `node --test`, with two additions. `test/support/register.js` teaches Node the two
Vite import suffixes the components are built on — `?raw` for a template, `?inline` for a
compiled sheet — so the tests run against the component sources rather than against a
bundle; and Node's own type stripping handles the `.ts` files, which is why every import
inside `src/ui` writes the extension out. The build runs first because one test drives the
real static server against `dist/`.

Covers the geometry primitives everything else is built on (segment intersection,
segment-to-segment distance, crossing detection and its de-duplication rules), the
minimum-vertex-cover solver that sets each stage's move budget, the move/bank economy,
the knot tracker's farm-proof ratchet, and the stage clock — both the model in isolation
(trimming, the margin curve, the target walking down past par, the thin-record widening,
the floor, outlier rejection) and
the rules about *when* it is read, which are driven through a real `Game`.

The UI has two files of its own. `hud-render.test.js` mounts index.html in a real DOM
(happy-dom) and drives the shipping components through it — element upgrade, shadow roots
and adopted stylesheets are the mechanism here, not a detail, so a stand-in that faked them
would be testing the stand-in. `hud-wiring.test.js` checks the seams without running
anything: that every component is three files and one tag named after its folder, that every
selector a class reaches for exists in its own markup, that every tag a template mounts is
one its class imports, that every event a component emits is one something listens for, and
that no component sheet reaches outside its own shadow root. Those run over every component
folder rather than a list, so a new one is covered by existing.

## Dev flags

| URL | Effect |
| --- | --- |
| `?debug=1` | Node dots, rope bounds, playfield margin, and a live readout of knots / travel / score terms. Logs the run seed. |
| `?seed=123` | Fixes the run seed, so every stage generates identically. |
| `?stage=7` | Skips the title screen and loads straight into that stage. |
| `?phone=1` | Forces the phone board (half the ropes) on or off, without a phone. |
| `?pool=0` | Ignores the shared pool; the clock runs off this device's own times alone. |

`?seed=123&stage=7&debug=1` reproduces one exact layout, every time.

## The pool API

Two endpoints, same origin by default — point `POOL.BASE_URL` elsewhere to split the game
off onto a CDN, and the CORS headers are already there for it.

| Route | Body | Effect |
| --- | --- | --- |
| `GET /api/pars` | — | `{ pars: { "7": { ms, n } } }` — one already-trimmed par per stage. Cached, and publicly cacheable for `POOL.PARS_MAX_AGE_S`. |
| `POST /api/times` | `{ stage, ms }` or `{ times: [...] }` | Files clear times. Returns `{ stored, received }`. |

The batch form exists because the client holds times it couldn't send and drains them
together. A submission is bounded (`POOL.MIN_MS`/`MAX_MS`) and clamped toward its stage's
typical time, and a whole batch is clamped against the pool as it stood before the batch,
so fifty entries cannot walk the clamp down with them. Reads and writes share one per-IP
rate limit, charged per entry rather than per request — the read is the expensive
endpoint, since it sorts every sample of every stage, so leaving it unmetered had it
backwards. None of that is real anti-cheat — nothing client-submitted can be — it is there
so one bad or forged number cannot poison a stage for everyone else.

| Env | Effect |
| --- | --- |
| `PORT` | Listen port (default 8000). |
| `UNTANGLE_DATA` | Pool file (default `server/data/pool.json`). |
| `UNTANGLE_TRUST_PROXY=N` | Read the client IP from `X-Forwarded-For`, counting `N` trusted proxies from the right: `1` behind nginx alone, `2` behind Cloudflare and then nginx. Each proxy appends the address it saw, so the entries further left are whatever the client sent. Only set it behind a proxy that appends; in front of one, it lets anyone forge their way around the rate limit. |

## Analytics

PostHog, in two halves that take two different keys. Copy `.env.example` to `.env` and fill
it in; with nothing set the game runs exactly as it did before there was any of this, which
is what a fresh checkout does.

```bash
npm run stats      # runs the three queries and prints what came back
```

That is the setup check. The server swallows every query failure on purpose — a game must
not break over analytics — which is right in production and useless while wiring it up, so
`npm run stats` runs the same three queries against the same endpoint and reports the errors
`refresh()` throws away. It is read-only, and it prints a fingerprint of the key rather than
the key. `npm start` and `npm run serve` read `.env` through Node's `--env-file-if-exists`;
real environment variables take precedence over it, so compose's values still win in
production.

**Capturing** happens in the browser on the *project* key (`phc_…`), which is write-only and
public by design — Vite inlines anything named `VITE_*` into `dist/`, so it ships to every
player on purpose. `posthog-js` is 229kB against the game's own 83kB, so it is imported
dynamically and lives in its own chunk: with no key configured the fetch never happens.

**Reading the numbers back** happens on the server on a *personal* key (`phx_…`, scope
`query:read`), which can read the whole project and therefore never goes near the client.
`server/stats.js` runs three HogQL queries every `ANALYTICS.REFRESH_MS` and keeps the answers
in one exported `stats` object; `/api/stats` serves that object, so the client gets numbers
and never the key that produced them.

| Route | Effect |
| --- | --- |
| `GET /api/stats` | `{ totalVisitors, currentVisitors, avgSessionSeconds, fetchedAt, live }`. Answered off the last refresh, so it is never slower than the object it reads. Publicly cacheable for `ANALYTICS.STATS_MAX_AGE_S`. |

The numbers are `null` until a query lands, and `null` is deliberately not `0`: a project
with no traffic reports zero visitors, a project with a bad key reports nothing, and `live`
is what separates the two. Each query fails independently and leaves its own number alone —
so an empty `sessions` table costs the average and not the visitor counts, and an outage
costs freshness rather than correctness.

| Env | Effect |
| --- | --- |
| `VITE_POSTHOG_KEY` | Project key, **build time only** — Vite inlines it, so it is a `--build-arg` in the Dockerfile, not a runtime variable. Unset disables capture. |
| `VITE_POSTHOG_HOST` | Ingest host (default `https://us.i.posthog.com`). |
| `POSTHOG_PERSONAL_API_KEY` | Personal key, runtime. Never `VITE_*`. Unset leaves `/api/stats` idle. |
| `POSTHOG_PROJECT_ID` | The number in the dashboard URL. |
| `POSTHOG_HOST` | Query host — the **app** host (default `https://us.posthog.com`), which is not the ingest host above. Pointing this at `us.i.posthog.com` 404s on a URL that looks right. |

Region has to match the key on both: an EU key against a US host authenticates and then
reports an empty project, which reads as "no traffic yet" rather than as the mistake it is.

### In production

The two halves are delivered by two different routes, because they are needed at two
different times.

The browser key is needed **at image build time** — Vite can only inline it then — so it is
a GitHub repository *variable* (`VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`) that CI passes to
`docker build` as a build arg. A variable rather than a secret on purpose: it ships to every
player anyway, and masking it in the logs would only make a typo harder to diagnose.

The server keys are needed **at container run time** and must never enter the image, so they
live on the box in `~/untangle.env`, which `deploy/deploy.sh` passes to compose with
`--env-file`:

```bash
# on the box, as the user the runner runs as — no sudo, it is that user's own home
umask 177 && cat > ~/untangle.env <<'EOF'
POSTHOG_PERSONAL_API_KEY=phx_...
POSTHOG_PROJECT_ID=...
POSTHOG_HOST=https://us.posthog.com
EOF
```

Two ways to get this wrong, both of which end in the stats staying idle with no error worth
reading. `sudo` leaves the file root-owned and unreadable by the runner. And `$HOME` is the
*runner's* home, which is not necessarily yours — if the runner is a service account, put
the file in its home, or point `UNTANGLE_ENV_FILE` wherever you like. `deploy.sh` prints
which of the two paths it took on every deploy, so the log says which happened.

Outside the checkout deliberately — `actions/checkout` cleans untracked files, so a `.env`
beside `compose.prod.yaml` would be deleted by the next deploy. If the file is absent the
deploy still proceeds and `/api/stats` serves nulls; analytics must never be the reason the
game and the pool fail to come back up. For the same reason the deploy health check stays on
`/api/pars` — gating it on `/api/stats` would roll the site back over a PostHog outage.

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

**The bank is a cushion, not savings**, and it is capped at 6. Uncapped it compounded —
the slack is a *proportional* margin on a cover that grows all run, so a clean player
banked one spare move a stage early on and four a stage by stage 20, reaching 37 and still
climbing. That is more spare moves than any single stage costs, so the budget stopped being
a constraint somewhere in the teens. The cap alone would pin everyone to the ceiling and
make the readout say the same thing about all of them, so the slack came down with it:

| after 20 stages | clean play | 10% over par | 20% over par |
| --- | --- | --- | --- |
| bank | 6 (capped) | 3 | 0 |

Spare moves above the cap are lost rather than deferred, including moves earned by a x10
detonation — the stat outlines itself while the bank is full, so the discard is visible
and there is a reason to spend down.

**The stage clock has no starting time**, because it isn't given one. The game has no
opinion about how long a board should take; it only has a record of how long it takes
people (`src/deadline.js`). The **shared pool** answers first, and the times on your own
device answer when it can't, which covers a first load offline, a dead server, and a stage
further out than anyone has reached. When both answer, the looser of the two wins. A stage
*nobody* has ever cleared still runs **untimed**, the clock only measuring it.

One fact shapes the whole model. Only clears are filed, and a clear is by definition faster
than the deadline it was played against. So the record is not "how long the stage takes";
it is "how long it took the people who made it", which is the fast end. Average that and
hand the average back as the next deadline and the number can only fall: every new sample
lands under the number that produced it. The first version of this model did exactly that,
with a margin that reached zero at stage 30, and simulated against a population of players
it left a median player clearing stage 10 one attempt in ten and nothing past par. That is
the "too hard" people reported, and it was structural rather than a matter of tuning.

The quote is now built to hold still under that bias, in five steps:

1. **Trim** the extremes off the stage's recorded times, top and bottom 10%, so the run
   interrupted by the doorbell and the freak lucky board both drop out.
2. **Target** the *slow* end of what survives: the 75th percentile, not the mean. The slow
   end of the clears is the closest thing on record to what the stage takes.
3. **Widen** a thin record. Below ten runs the trim cannot reject anything, so the quote is
   multiplied by up to 1.5 (one run) tapering to nothing at ten. One expert's debut clear is
   not a par for everyone after them.
4. **Add the margin** for the stage: +40% at stage 1, easing to +30% at stage 30 and
   holding there. It never reaches zero, because a margin of zero is the ratchet above.
5. **Floor** it at eight seconds. Under that a deadline is a reflex test, not a clock. It
   binds on the tutorial stages, where the record says two seconds and a first-timer needs
   ten to read the board; late pars are several times it.

| stage | 1 | 5 | 10 | 15 | 20 | 25 | **30+** |
| --- | --- | --- | --- | --- | --- | --- | --- |
| margin | +40% | +39% | +37% | +35% | +33% | +32% | **+30%** |

**Past stage 30 the margin holds and the target does the tightening.** The percentile the
stage is quoted at eases from the 75th down to the 60th over the next twenty stages and
stops there, so the ask slides from "a slow clear" to "a fairly typical one" and never on
to the fastest run, which on a pooled record is somebody else's best day. With twelve runs
on record from 42s to 75s:

| stage | 30 | 35 | 40 | 45 | 50+ |
| --- | --- | --- | --- | --- | --- |
| percentile | 75th | 71st | 68th | 64th | **60th** |
| deadline | 1:25 | 1:24 | 1:23 | 1:21 | **1:20** |

The pool and the device run the identical quote, so the two populations are asked the same
question. **When both have a record, the looser answer is the deadline** (`CLOCK.OWN_FLOOR`).
A pooled quote can describe a stage this particular player cannot clear, and their own
record is the standard they have demonstrably met, so they are never held past it. It cuts
the other way too: a player faster than the pool is quoted the pool's time, not their own.
It does nothing on a stage the player has never cleared, which is the real price of pooling;
the thin-record widening and the floor are what protect a new player there.

Simulated against a lognormal population (skill spread 0.4, per-attempt noise 0.3), a
median-skill player now clears about 89% of attempts at stage 1, 87% at stage 10, 78% at
stage 20, 71% at par and 39% at stage 50, against 51%, 17%, 3%, 0% and 0% before.

Only clears are recorded, locally and in the pool; a stage lost to the clock teaches
neither anything, which is the point — filing it would teach the model that the stage takes
exactly as long as the deadline it just failed. Trimming the *fast* end is what stops a
freak clear becoming a permanent target, and a submitted time is clamped toward its stage's
typical one before it lands, so a single forged run cannot drag a stage's par down after it.

The clock stops behind an open dialog, and the deadline is judged **at the drop**: a rope
released with a tenth of a second to spare has landed, and the unscored settle running on
past zero cannot take that back. That courtesy is the settle's alone. **The buzzer ends the
stage on the frame it goes**, whatever the player was doing — a rope still in hand is taken
out of it, where it stands, and the gesture is neither charged for nor scored. Waiting for
the drop instead would leave the clock reading zero on a board that still answered to the
pointer, which is the one moment the readout must not be able to lie.

**The endgame is said by the board, not only by the readout.** Inside the last *two* fifths
of the deadline the background starts going red, and inside the last 15% the board itself
shakes, ±5px, ramping the whole way. Two thresholds rather than one so they are two pieces
of news: the colour says the endgame has started, the shake says it is nearly over. Both
ramps ease out — most of the change is spent in the first moments past the threshold, so
crossing one is an event rather than a gradient nobody notices, and the slow approach to
full is the long tail. Both are fractions
of the deadline rather than counts of seconds, because nearly out of forty seconds and
nearly out of three minutes are the same feeling and different numbers — and because an
untimed stage pins its fraction at 1, so neither ever fires on a board nobody has cleared.

The wash is a second radial gradient laid straight over the one that was already there, and
it runs the *other* way: weakest over the middle where the ropes are, strongest at the
edges, so the colour closes in from the frame instead of settling on the puzzle. It caps at
25% and breathes, faster the further gone the clock is — a tint held at a fixed value reads
as a filter somebody left on, the same tint moving reads as an alarm. The player is still
expected to clear this stage, and they cannot clear what they cannot see.

The shake moves the drawing, not the model, so a rope ends up as much as 5px from where the
pointer thinks it is — well inside the 22px grab radius, and being slightly harder to grab
in the last four seconds is the effect rather than a cost of it. It shakes the canvas and
not the HUD, which is carrying the clock the player needs to read while it happens, and it
stands down entirely under `prefers-reduced-motion` — the wash carries the same news in a
form nobody has to brace for. Both alarms stop the instant the stage does, so a game-over
panel never comes up over a board still shaking itself apart.

**A stage does not end in a scoreboard, and the next one does not begin with a countdown.**
It ends in a card carrying the two numbers worth carrying — what the stage paid, big, and
the run total under it, small — which holds for three seconds and then hands over the next
board, already built behind it. There used to be a count on the way in as well: a second
card, a swipe between them, and `GO`. It was a wait in front of a board you could already
see, three times a minute, and the one thing it protected against — a clock starting before
anyone was looking — is a thing the clock does not do anyway, because it does not tick
behind a panel.

**The hold is not a number.** It is the card itself: a wash of 10% white behind the text
whose level falls from the top edge of the panel to the bottom across the three seconds, so
the wait says how much of itself is left. **Play stage** and **Pause**, both inside the
panel under the text, are the two ways to argue with it, and `Enter` is the first of them
from the keyboard. Held, the wash steps back and the pause button takes a yellow stroke
that breathes, because a stopped level and a slow one look the same.

Everything else a breakdown used to list — per-move, tightness, efficiency, carried moves —
is still tracked and still feeds the score; it is simply not worth a stop between every
stage, and `?debug=1` has it live. Best per stage and the clear time the clock learns from
are still banked on every clear.

**Briefings** are the one thing that still opens a stage with a panel, and there are two of
them. A mechanic that can end a run without ever having been named gets one modal, on the
stage it arrives, and never again: the clock on stage 1, and the cursed rope on stage 16 —
`CURSED.FROM`, derived rather than typed, so the panel cannot drift off the stage it is
about. They are keyed to the stage the thing *appears on* rather than the one before it, so
the black rope is on the board behind the panel while you read about it.

The clock briefing has two answers and picks between them at open time, because a stage
nobody in the pool has ever cleared genuinely has no deadline to quote and a panel that
announces one would be lying. Seen briefings are remembered in `progress.briefed`; **Back
to stage 1** in settings is what puts them back, which makes it the only way to read one
twice.

**Rip & Tear**, on the title screen, skips straight to stage 30 — par, where the margin
reaches zero — with the run's usual cushion and nothing else. It gets a panel of its own on
the way in, which has something to say about the decision. That one is not remembered and
not an explanation: it belongs to the button rather than to the stage it drops you on, so
it shows up every single time.

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
and a mid-stage resize cannot retroactively re-value work already done. It is an input to
the score rather than a readout of its own; `?debug=1` is where to see it.

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
