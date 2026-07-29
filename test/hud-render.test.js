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

test('the cleared card comes up alone, carrying what the stage paid', () => {
  hud.showCleared({ stage: 4, score: 12850.4, total: 41200 });

  assert.equal(el('overlay-interlude').classList.contains('is-hidden'), false);
  assert.equal(el('cleared-stage').textContent, '4');
  assert.equal(el('card-cleared').classList.contains('is-hidden'), false);
  assert.equal(el('card-countdown').classList.contains('is-hidden'), true);

  // Rounded and grouped, the same as the HUD's own score readout.
  assert.equal(el('cleared-score').textContent, '12,850');
  assert.equal(el('cleared-total').textContent, '41,200');
});

test('a stage worth nothing still reads as a number rather than a blank', () => {
  hud.showCleared({ stage: 1, score: 0, total: 0 });
  assert.equal(el('cleared-score').textContent, '0');
  assert.equal(el('cleared-total').textContent, '0');
});

test('the countdown swaps in, and the two cards animate as a pair', () => {
  hud.showCleared({ stage: 4, score: 900, total: 900 });
  hud.showCountdown(5, false);

  assert.equal(el('card-cleared').classList.contains('is-leaving'), true, 'out to the left');
  assert.equal(el('card-countdown').classList.contains('is-entering'), true, 'in from the right');
  assert.equal(el('card-countdown').classList.contains('is-hidden'), false);
  assert.equal(el('countdown-stage').textContent, '5');
});

test('a countdown with nothing to replace just arrives', () => {
  hud.hideInterlude();
  hud.showCountdown(1, false);

  assert.equal(el('card-cleared').classList.contains('is-hidden'), true);
  assert.equal(el('card-countdown').classList.contains('is-entering'), false, 'nothing to swap with');
  assert.equal(el('card-countdown').classList.contains('is-hidden'), false);
});

test('skip is offered for the whole sequence, including the cleared card', () => {
  // It used to be hidden outside the countdown, because skipping the CLEARED card would
  // have handed back the solved board. Skipping now *builds* the next board on the way
  // through, so there is no phase where the button would be present but inert — and none
  // where it has to be taken away either.
  hud.showCleared({ stage: 4, score: 900, total: 900 });
  assert.equal(el('btn-skip').classList.contains('is-hidden'), false, 'offered on cleared');

  hud.showCountdown(5, false);
  assert.equal(el('btn-skip').classList.contains('is-hidden'), false, 'and on the count');
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

test('the skip button out-specifies .btn, or its icon is not centred', () => {
  // `.btn` sets `padding: 11px 22px` for a text label and is declared after the interlude
  // block, so a bare `.interlude__skip` rule loses the tie on equal specificity. With
  // box-sizing: border-box and a fixed width that left a 2px content box for a 20px icon.
  // Nothing about the result looks like a specificity problem when you are staring at it,
  // which is exactly why it is worth pinning.
  assert.match(css, /\.btn\.interlude__skip\s*\{/, 'the padding override must be qualified');

  const rule = css.slice(css.indexOf('.btn.interlude__skip'));
  const body = rule.slice(rule.indexOf('{'), rule.indexOf('}'));
  assert.match(body, /padding:\s*0/, 'the text-label padding has to be cleared');
  assert.match(body, /color:\s*#fff/, 'and the colour set, since the icon inherits it');
});

test('GO is marked as its own thing, and the number is not', () => {
  hud.setCountdown('2.41');
  assert.equal(el('countdown-value').textContent, '2.41');
  assert.equal(el('countdown-value').classList.contains('is-go'), false);

  hud.setCountdown('GO');
  assert.equal(el('countdown-value').textContent, 'GO');
  assert.equal(el('countdown-value').classList.contains('is-go'), true);
});

test('the taunt belongs to Rip & Tear and is put away afterwards', () => {
  hud.showCountdown(30, true);
  assert.equal(el('countdown-taunt').classList.contains('is-hidden'), false);

  hud.showCountdown(31, false);
  assert.equal(el('countdown-taunt').classList.contains('is-hidden'), true);
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

test('hiding the interlude takes both cards down with it', () => {
  hud.showCleared({ stage: 4, score: 900, total: 900 });
  hud.showCountdown(5, false);
  hud.hideInterlude();

  assert.equal(el('overlay-interlude').classList.contains('is-hidden'), true);
  assert.equal(el('card-cleared').classList.contains('is-hidden'), true);
  assert.equal(el('card-countdown').classList.contains('is-hidden'), true);
  assert.equal(el('card-cleared').classList.contains('is-leaving'), false, 'and resets the animation');
});

test('the interlude counts as an overlay, so input stands down behind it', () => {
  hud.hideTitle();
  hud.hideGameOver();
  hud.hideSettings();
  hud.hideInterlude();
  assert.equal(hud.anyOverlayOpen, false);

  hud.showCleared({ stage: 2, score: 10, total: 10 });
  assert.equal(hud.anyOverlayOpen, true, 'a card up must freeze the board');
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

test('Enter skips the wait between stages', () => {
  const { fired, press } = keyboardHud();

  press('Enter');
  assert.deepEqual(fired, [['onSkip']]);
});

test('Enter does not fire the shortcut while a button has focus', () => {
  // Enter already activates a focused button. Hijacking it here would fire both, so
  // tabbing to PAUSE and pressing Enter would pause and skip in one keystroke.
  const { fired, press } = keyboardHud();
  globalThis.document.activeElement = { tagName: 'BUTTON' };

  press('Enter');
  assert.deepEqual(fired, [], 'the button gets it, not the shortcut');

  globalThis.document.activeElement = null;
  press('Enter');
  assert.deepEqual(fired, [['onSkip']], 'and it works again once focus is elsewhere');
});

test('held keys do not repeat-fire the hotkeys', () => {
  const { fired, press } = keyboardHud();

  press('Enter', { repeat: true });
  press('r', { repeat: true });
  assert.deepEqual(fired, [], 'auto-repeat is not a stream of skips and restarts');
});

test('a modified Enter belongs to the browser, not the game', () => {
  const { fired, press } = keyboardHud();

  press('Enter', { ctrlKey: true });
  press('Enter', { metaKey: true });
  assert.deepEqual(fired, []);
});
