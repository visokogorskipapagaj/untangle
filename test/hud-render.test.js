import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * The HUD driven against the real index.html, through a DOM stand-in.
 *
 * hud-wiring.test.js reads the source and checks that the ids line up. This runs the
 * thing: a method that forgets to unhide a card, a class the stylesheet never heard of, or
 * a readout that formats the wrong branch are all live bugs that source-grepping cannot
 * see, and all of them are invisible until someone actually plays a stage.
 *
 * The shim is deliberately thin — enough DOM for the HUD and nothing more.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'styles.css'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));

/** class -> id of the first element carrying it, which is all querySelector needs here. */
const firstByClass = new Map();
for (const tag of html.matchAll(/<[a-z]+[^>]*class="([^"]+)"[^>]*>/g)) {
  const id = tag[0].match(/id="([A-Za-z0-9_-]+)"/);
  for (const cls of tag[1].split(/\s+/)) {
    if (!firstByClass.has(cls)) firstByClass.set(cls, id ? id[1] : `anon:${cls}`);
  }
}

function makeDom() {
  const nodes = new Map();
  const node = (name) => {
    if (nodes.has(name)) return nodes.get(name);
    const classes = new Set();
    const attrs = new Map();
    const el = {
      name,
      classes,
      attrs,
      textContent: '',
      style: {},
      offsetWidth: 0,
      checked: false,
      addEventListener() {},
      setAttribute: (key, value) => attrs.set(key, String(value)),
      getAttribute: (key) => (attrs.has(key) ? attrs.get(key) : null),
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (c) => classes.has(c),
        toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      },
    };
    nodes.set(name, el);
    return el;
  };

  globalThis.document = {
    getElementById(id) {
      assert.ok(htmlIds.has(id), `hud.js looks up #${id}, which index.html does not define`);
      return node(id);
    },
    querySelector(selector) {
      const cls = selector.replace(/^\./, '');
      assert.ok(firstByClass.has(cls), `hud.js selects ${selector}, which index.html has no element for`);
      return node(firstByClass.get(cls));
    },
  };
  // Keydown handlers are captured rather than dropped: the hotkeys are real behaviour, and
  // the Enter binding in particular has a guard that only shows up when it is exercised.
  globalThis.keyHandlers = [];
  globalThis.window = {
    addEventListener(type, fn) {
      if (type === 'keydown') globalThis.keyHandlers.push(fn);
    },
  };
  globalThis.document.activeElement = null;
  return node;
}

const node = makeDom();
const { Hud } = await import('../src/hud.js');

// Every handler call becomes a no-op; the constructor binding them is the part under test.
const hud = new Hud(new Proxy({}, { get: () => () => {} }));

const el = (id) => node(id);
const box = (cls) => node(firstByClass.get(cls));

const stats = (over = {}) => ({
  stage: 4,
  knots: 3,
  movesLeft: 2,
  bank: 5,
  drawingFromBank: false,
  timeLeft: 30000,
  score: 1234,
  chain: 0,
  chainFraction: 0,
  cursedMult: 0,
  ...over,
});

// --- the readouts -------------------------------------------------------------------

test('the clock reads in minutes, drops to tenths, and names the untimed stage', () => {
  hud.setStats(stats({ timeLeft: 95000 }));
  assert.equal(el('stat-time').textContent, '1:35');
  assert.equal(box('stat--time').classList.contains('is-low'), false);

  hud.setStats(stats({ timeLeft: 8000 }));
  assert.equal(box('stat--time').classList.contains('is-low'), true, 'amber inside the warning');

  hud.setStats(stats({ timeLeft: 4200 }));
  assert.equal(el('stat-time').textContent, '4.2');
  assert.equal(box('stat--time').classList.contains('is-critical'), true);
  assert.equal(box('stat--time').classList.contains('is-low'), false, 'one state at a time');

  hud.setStats(stats({ timeLeft: Infinity }));
  assert.equal(el('stat-time').textContent, '∞');
  assert.equal(box('stat--time').classList.contains('is-untimed'), true);
  assert.equal(box('stat--time').classList.contains('is-critical'), false);
});

test('the bank lights up only while it is being spent', () => {
  hud.setStats(stats({ drawingFromBank: true }));
  assert.equal(box('stat--bank').classList.contains('is-burning'), true);

  hud.setStats(stats({ drawingFromBank: false }));
  assert.equal(box('stat--bank').classList.contains('is-burning'), false);
});

test('a full bank is marked, so discarded moves are not silent', () => {
  hud.setStats(stats({ bankFull: true }));
  assert.equal(box('stat--bank').classList.contains('is-full'), true);

  hud.setStats(stats({ bankFull: false }));
  assert.equal(box('stat--bank').classList.contains('is-full'), false);
});

test('burning outranks full — one box cannot say both', () => {
  // Full is a nudge to spend; burning is about to end the run. If the bank is somehow
  // both, the one that costs something has to be the one showing.
  hud.setStats(stats({ bankFull: true, drawingFromBank: true }));
  assert.equal(box('stat--bank').classList.contains('is-burning'), true);
  assert.equal(box('stat--bank').classList.contains('is-full'), false);
});

// --- between stages -------------------------------------------------------------------

test('the cleared card comes up carrying what the stage paid', () => {
  hud.showCleared({ stage: 4, score: 12850.4, total: 41200 });

  assert.equal(el('overlay-interlude').classList.contains('is-hidden'), false);
  assert.equal(el('cleared-stage').textContent, '4');

  // Rounded and grouped, the same as the HUD's own score readout.
  assert.equal(el('cleared-score').textContent, '12,850');
  assert.equal(el('cleared-total').textContent, '41,200');
});

test('a stage worth nothing still reads as a number rather than a blank', () => {
  hud.showCleared({ stage: 1, score: 0, total: 0 });
  assert.equal(el('cleared-score').textContent, '0');
  assert.equal(el('cleared-total').textContent, '0');
});

test('the controls live inside the modal, under the text', () => {
  // They used to float over the board below the panel, which is why they were sized to match
  // the HUD's icon buttons. Inside the panel they are ordinary panel buttons — and being
  // inside means the markup order is what puts them under the text rather than over it.
  const panel = html.slice(html.indexOf('id="overlay-interlude"'), html.indexOf('Briefings.'));
  const headline = panel.indexOf('interlude__headline');
  const actions = panel.indexOf('interlude__actions');

  assert.ok(headline > -1 && actions > headline, 'the buttons come after the card text');
  assert.ok(
    panel.indexOf('id="btn-pause"') > actions && panel.indexOf('id="btn-skip"') > actions,
    'and both of them are in that row',
  );
});

test('starting the stage is the green button, and says what it does', () => {
  // It is the way out of a wait, which makes it the thing the player is there to press —
  // and "Skip" described the mechanism rather than the outcome.
  const button = html.slice(html.indexOf('id="btn-skip"'), html.indexOf('</button>', html.indexOf('id="btn-skip"')));

  assert.match(button, /class="[^"]*\bbtn--primary\b/, 'the primary treatment is the green one');
  assert.match(button, />Play stage</, 'with a visible label saying so');
  assert.ok(!/>Skip</.test(button), 'and nothing left calling it a skip');
});

test('the skip icon is drawn rather than typed, and takes its colour from the button', () => {
  // Deliberately says nothing about how many paths the artwork uses — that changed once
  // already when the icon was swapped, and it was never the thing that mattered. What has
  // to hold is that it is inline SVG (a codepoint like ⏩ lands as a colour emoji on some
  // platforms and tofu on others) and that it paints with currentColor, which is the hook
  // the stylesheet uses to colour it.
  const from = html.indexOf('id="btn-skip"');
  const button = html.slice(from, html.indexOf('</button>', from));

  assert.match(button, /<svg[^>]*viewBox="[^"]+"/, 'inline SVG with a viewBox, so it scales');
  assert.match(button, /fill="currentColor"/, 'the colour comes from the button, not the file');
  assert.match(button, /aria-label="[^"]+"/, 'an icon-only button still has to say what it is');
  assert.ok(!/&#\d+;/.test(button), 'and no glyph smuggled in beside it');
});

test('the hold is a level behind the card, and it falls', () => {
  hud.setCountdown(1);
  assert.equal(el('interlude-timer').style.transform, 'scaleY(1.000)', 'full at the start');

  hud.setCountdown(0.25);
  assert.equal(el('interlude-timer').style.transform, 'scaleY(0.250)');

  hud.setCountdown(0);
  assert.equal(el('interlude-timer').style.transform, 'scaleY(0.000)', 'and empty when it is up');
});

test('the hold bar is anchored at the bottom, so the level falls rather than rises', () => {
  // scaleY alone says nothing about which edge moves. Anchored anywhere else the tint
  // shrinks upward, which reads as filling — the exact opposite of counting down.
  const rule = css.slice(css.indexOf('.interlude__timer i'));
  const body = rule.slice(rule.indexOf('{'), rule.indexOf('}'));
  assert.match(body, /transform-origin:[^;]*bottom/, 'the bottom edge is the one that stays');
  assert.match(body, /background:\s*var\(--white-10\)/, 'drawn in the shared 10% white token');
  assert.match(css, /--white-10:\s*rgba\(255,\s*255,\s*255,\s*0\.1\)/, 'which is what it says');
});

test('a level written twice is only written to the DOM once', () => {
  // It is set every frame while a card is up. Rounded to the same three decimals it is the
  // same picture, and a transform re-written sixty times a second for it is sixty style
  // recalculations for nothing.
  hud.setCountdown(0.5);
  el('interlude-timer').style.transform = 'touched';
  hud.setCountdown(0.5004);
  assert.equal(el('interlude-timer').style.transform, 'touched', 'no second write');
});

// --- briefings ---------------------------------------------------------------------------

test('a briefing opens one card and puts every other one away', () => {
  assert.equal(hud.showBriefing('cursed', { stage: 16, limit: 40000 }), true);

  assert.equal(el('overlay-briefing').classList.contains('is-hidden'), false);
  assert.equal(el('brief-stage').textContent, '16');
  assert.equal(el('brief-cursed').classList.contains('is-hidden'), false);
  assert.equal(el('brief-clock').classList.contains('is-hidden'), true);
  assert.equal(el('brief-riptear').classList.contains('is-hidden'), true);

  hud.showBriefing('riptear', { stage: 30, limit: null });
  assert.equal(el('brief-riptear').classList.contains('is-hidden'), false);
  assert.equal(el('brief-cursed').classList.contains('is-hidden'), true, 'the last one is gone');
});

test('a card the markup does not have opens nothing at all', () => {
  // The stage -> card map lives in config.js and the cards live in index.html. A key with
  // no card must be a briefing that does not happen, not a stage load that throws.
  hud.hideBriefing();
  assert.equal(hud.showBriefing('nonesuch', { stage: 2 }), false);
  assert.equal(el('overlay-briefing').classList.contains('is-hidden'), true);
});

test('the clock briefing quotes the deadline, in the units a briefing wants', () => {
  hud.showBriefing('clock', { stage: 1, limit: 72400 });

  assert.equal(el('brief-clock-limit').textContent, '1:13');
  assert.equal(el('brief-clock-timed').classList.contains('is-hidden'), false);
  assert.equal(el('brief-clock-untimed').classList.contains('is-hidden'), true);
});

test('a briefing on an untimed stage does not invent a time limit', () => {
  // Stage 1 with no record anywhere is genuinely untimed, and a panel announcing a clock
  // that is not running is worse than no panel.
  hud.showBriefing('clock', { stage: 1, limit: null });

  assert.equal(el('brief-clock-timed').classList.contains('is-hidden'), true);
  assert.equal(el('brief-clock-untimed').classList.contains('is-hidden'), false);
  assert.equal(el('brief-clock-limit').textContent, '∞', 'and it says so in the HUD\'s own sign');
});

test('the tenths the readout drops to are not a thing a briefing says', () => {
  // formatClock switches to a decimal inside the last five seconds, which is urgency rather
  // than information. A sentence about a clock wants "0:04", not "4.2".
  hud.showBriefing('clock', { stage: 1, limit: 4200 });
  assert.equal(el('brief-clock-limit').textContent, '0:05');
});

test('the briefing panel is one door out, and it is the same green one', () => {
  const from = html.indexOf('id="btn-brief-play"');
  assert.ok(from > -1, 'the briefing needs a way out');
  const button = html.slice(from, html.indexOf('</button>', from));

  assert.match(button, /class="[^"]*\bbtn--primary\b/, 'the primary treatment, as on the card');
  assert.match(button, />Play stage</, 'saying the same thing it says there');
  assert.match(button, /<svg[^>]*viewBox="[^"]+"/, 'and carrying the same drawn icon');
});

test('every briefing card the HUD can open exists in the markup', () => {
  // The map in hud.js is the join between BRIEFING's keys and the cards. A key with no card
  // is a briefing that silently never opens, which is invisible until stage 16.
  const source = readFileSync(join(root, 'src/hud.js'), 'utf8');
  const config = readFileSync(join(root, 'src/config.js'), 'utf8');

  const mapped = [...source.matchAll(/^ {8}([a-z]+): \$\('(brief-[a-z-]+)'\)/gm)];
  assert.ok(mapped.length >= 3, 'sanity: the briefing card map was parsed');
  for (const [, , id] of mapped) assert.ok(htmlIds.has(id), `index.html is missing #${id}`);

  // And the other side of the join: every card config can ask for is one the HUD has.
  const known = new Set(mapped.map(([, key]) => key));
  const stages = config.match(/STAGES:\s*\{([^}]*)\}/);
  const riptear = config.match(/RIP_AND_TEAR:\s*'([a-z]+)'/);
  assert.ok(stages && riptear, 'BRIEFING should declare both its stage map and Rip & Tear\'s');

  const wanted = [...stages[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).concat(riptear[1]);
  assert.ok(wanted.length >= 3, 'sanity: the config side was parsed');
  const orphans = wanted.filter((key) => !known.has(key));
  assert.deepEqual(orphans, [], `BRIEFING names cards hud.js cannot open: ${orphans}`);
});

test('pausing relabels the button and marks the overlay', () => {
  hud.setPaused(true);
  assert.equal(el('pause-label').textContent, 'Resume');
  assert.equal(el('btn-pause').getAttribute('title'), 'Resume', 'and on hover');
  assert.equal(el('overlay-interlude').classList.contains('is-paused'), true);

  hud.setPaused(false);
  assert.equal(el('pause-label').textContent, 'Pause');
  assert.equal(el('overlay-interlude').classList.contains('is-paused'), false);

  // The button's own content is the two icons, so the label must never be written there.
  // That is the whole failure mode: `textContent =` deletes them, and the button goes on
  // working and reading correctly to a screen reader while being invisible on screen.
  assert.equal(el('btn-pause').textContent, '', 'the label never lands in the button body');
});

test('a held sequence is marked on the button that held it', () => {
  // Everything else in the modal expresses pause by not moving, which is indistinguishable
  // from a phase that is simply long. The stroke is the only thing saying held rather than
  // slow, so it has to be both coloured and alive.
  const rule = css.match(/\.overlay--interlude\.is-paused \.interlude__pause \{([^}]*)\}/);
  assert.ok(rule, 'the paused overlay must reach the pause button itself');
  assert.match(rule[1], /border-color:\s*var\(--amber\)/, 'a yellow stroke');
  assert.match(rule[1], /animation:\s*pause-breathe/, 'that breathes');
  assert.match(css, /@keyframes pause-breathe/, 'and the pulse it names exists');
});

test('both panels between the stages count as overlays, so input stands down', () => {
  hud.hideTitle();
  hud.hideGameOver();
  hud.hideSettings();
  hud.hideInterlude();
  hud.hideBriefing();
  assert.equal(hud.anyOverlayOpen, false);
  assert.equal(hud.briefingOpen, false);

  hud.showCleared({ stage: 2, score: 10, total: 10 });
  assert.equal(hud.anyOverlayOpen, true, 'a card up must freeze the board');

  hud.hideInterlude();
  hud.showBriefing('clock', { stage: 1, limit: null });
  assert.equal(hud.briefingOpen, true);
  assert.equal(hud.anyOverlayOpen, true, 'and so must a briefing — the clock rides on this');

  hud.hideBriefing();
  assert.equal(hud.anyOverlayOpen, false);
});

// --- game over --------------------------------------------------------------------------

test('the game-over panel says which of the two ran out', () => {
  // The wording is free to change; which of the two ran out is not. The moves counter and
  // the clock sit at opposite ends of the HUD, and the panel is the only thing that says
  // which one just ended the run.
  hud.showGameOver({ stage: 12, knots: 3, reason: 'time' });
  assert.equal(el('over-stage').textContent, '12');
  assert.equal(el('over-reason').textContent, 'Out of time');
  assert.match(el('over-detail').textContent, /3 knots/, 'and how much was left');
  assert.match(el('over-detail').textContent, /clock/i, 'named as the clock');

  hud.showGameOver({ stage: 4, knots: 1, reason: 'moves' });
  assert.equal(el('over-reason').textContent, 'Out of moves');
  assert.match(el('over-detail').textContent, /1 knot\b/, 'singular, not "1 knots"');
  assert.match(el('over-detail').textContent, /moves/i, 'named as the moves');
});

// --- the stylesheet knows about all of it ------------------------------------------------

test('every class the HUD toggles has a rule in the stylesheet', () => {
  // A renamed or mistyped class fails completely silently: the element gets the class, the
  // stylesheet ignores it, and the state simply never shows.
  const source = readFileSync(join(root, 'src/hud.js'), 'utf8');
  const toggled = new Set(
    [...source.matchAll(/classList\.(?:toggle|add)\(\s*'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]),
  );
  assert.ok(toggled.size >= 8, 'sanity: toggles were parsed');

  const missing = [...toggled].filter((cls) => !css.includes(`.${cls}`));
  assert.deepEqual(missing, [], `hud.js toggles classes the stylesheet never styles: ${missing}`);
});

// --- hotkeys ------------------------------------------------------------------------------

/** A HUD whose handler calls are recorded, plus the keydown listener it just bound. */
function keyboardHud() {
  const fired = [];
  const handlers = new Proxy({}, { get: (_, name) => (...args) => fired.push([name, ...args]) });
  new Hud(handlers);
  return { fired, press: (key, opts = {}) => globalThis.keyHandlers.at(-1)({ key, ...opts }) };
}

test('Enter is the way past whatever is between you and the board', () => {
  const { fired, press } = keyboardHud();

  press('Enter');
  assert.deepEqual(fired, [['onPlayStage']]);
});

test('Enter does not fire the shortcut while a button has focus', () => {
  // Enter already activates a focused button. Hijacking it here would fire both, so
  // tabbing to PAUSE and pressing Enter would pause and start the stage in one keystroke.
  const { fired, press } = keyboardHud();
  globalThis.document.activeElement = { tagName: 'BUTTON' };

  press('Enter');
  assert.deepEqual(fired, [], 'the button gets it, not the shortcut');

  globalThis.document.activeElement = null;
  press('Enter');
  assert.deepEqual(fired, [['onPlayStage']], 'and it works again once focus is elsewhere');
});

test('held keys do not repeat-fire the hotkeys', () => {
  const { fired, press } = keyboardHud();

  press('Enter', { repeat: true });
  press('r', { repeat: true });
  assert.deepEqual(fired, [], 'auto-repeat is not a stream of stage starts and restarts');
});

test('a modified Enter belongs to the browser, not the game', () => {
  const { fired, press } = keyboardHud();

  press('Enter', { ctrlKey: true });
  press('Enter', { metaKey: true });
  assert.deepEqual(fired, []);
});
