import assert from 'node:assert/strict';
import test from 'node:test';

import { COMBO } from '../src/config.js';
import { installDom, read } from './support/dom.js';

/**
 * The UI driven against the real components, in a real DOM.
 *
 * hud-wiring.test.js reads the sources and checks that the joins line up. This runs the
 * thing: a method that forgets to unhide a card, an attribute the stylesheet never heard of,
 * or a readout that formats the wrong branch are all live bugs that source-grepping cannot
 * see, and all of them are invisible until someone actually plays a stage.
 *
 * The page is index.html and the components are the ones that ship. Nothing here is a
 * stand-in except the handlers, which have nowhere to go in a test.
 */

const window = installDom();
const { document } = window;

const { Hud } = await import('../src/hud.ts');

// Every handler call becomes a no-op; the constructor binding them is the part under test.
const hud = new Hud(new Proxy({}, { get: () => () => {} }));

/** A region, by tag — the same handle the Hud itself holds. */
const region = (tag) => document.querySelector(tag);

/** One readout in the HUD strip, reached the way the HUD reaches it. */
const stat = (name) => region('u-hud').shadowRoot.querySelector(`[data-stat="${name}"]`);

/** The text a stat is currently showing. */
const shows = (name) => stat(name).shadowRoot.querySelector('.value').textContent;

/** The single state attribute a stat carries, or '' for the resting state. */
const state = (name) => stat(name).getAttribute('state') ?? '';

/** Something inside a region's shadow root. */
const part = (tag, selector) => region(tag).shadowRoot.querySelector(selector);

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

test('the page mounts as components rather than as unknown tags', () => {
  // The one failure that makes every other test here meaningless: if the elements never
  // upgraded, the assertions below would be reading inert markup.
  for (const tag of ['u-hud', 'u-chain-meter', 'u-title-screen', 'u-interlude', 'u-briefing',
    'u-game-over', 'u-settings']) {
    assert.ok(window.customElements.get(tag), `${tag} was never registered`);
    assert.ok(region(tag).shadowRoot, `${tag} is in the page but never upgraded`);
  }
});

test('the clock reads in minutes, drops to tenths, and names the untimed stage', () => {
  hud.setStats(stats({ timeLeft: 95000 }));
  assert.equal(shows('time'), '1:35');
  assert.equal(state('time'), '');

  hud.setStats(stats({ timeLeft: 8000 }));
  assert.equal(state('time'), 'low', 'amber inside the warning');

  hud.setStats(stats({ timeLeft: 4200 }));
  assert.equal(shows('time'), '4.2');
  assert.equal(state('time'), 'critical', 'and one state at a time');

  hud.setStats(stats({ timeLeft: Infinity }));
  assert.equal(shows('time'), '∞');
  assert.equal(state('time'), 'untimed');
});

test('the bank lights up only while it is being spent', () => {
  hud.setStats(stats({ drawingFromBank: true }));
  assert.equal(state('bank'), 'burning');

  hud.setStats(stats({ drawingFromBank: false }));
  assert.equal(state('bank'), '');
});

test('a full bank is marked, so discarded moves are not silent', () => {
  hud.setStats(stats({ bankFull: true }));
  assert.equal(state('bank'), 'full');

  hud.setStats(stats({ bankFull: false }));
  assert.equal(state('bank'), '');
});

test('burning outranks full — one box cannot say both', () => {
  // Full is a nudge to spend; burning is about to end the run. If the bank is somehow both,
  // the one that costs something has to be the one showing. A single `state` attribute makes
  // that structural rather than a rule about which class wins.
  hud.setStats(stats({ bankFull: true, drawingFromBank: true }));
  assert.equal(state('bank'), 'burning');
});

test('the readouts carry the numbers they were handed', () => {
  hud.setStats(stats({ stage: 7, knots: 0, movesLeft: 12, bank: 3, score: 98765 }));
  assert.equal(shows('stage'), '7');
  assert.equal(shows('knots'), '0');
  assert.equal(shows('movesLeft'), '12');
  assert.equal(shows('bank'), '3');
  assert.equal(shows('score'), '98,765', 'grouped, like every other score in the game');
  assert.equal(state('knots'), 'clear', 'and a cleared board says so');
});

test('a readout written twice is only written to the DOM once', () => {
  // Every stat is set sixty times a second and almost never changes. The guard is the
  // difference between a HUD and a stream of style recalculations.
  hud.setStats(stats({ score: 1234 }));
  const value = stat('score').shadowRoot.querySelector('.value');
  value.textContent = 'touched';
  hud.setStats(stats({ score: 1234 }));
  assert.equal(value.textContent, 'touched', 'no second write');
});

test('the move-cost and bank-gain popups fire with a sign on them', () => {
  hud.showMoveDelta(-3);
  const cost = stat('movesLeft').shadowRoot.querySelector('.delta');
  assert.equal(cost.textContent, '-3');
  assert.ok(cost.classList.contains('is-firing'));

  hud.showBankDelta(2);
  const gain = stat('bank').shadowRoot.querySelector('.delta');
  assert.equal(gain.textContent, '+2', 'earned moves are signed too, the other way');
});

// --- the chain meter --------------------------------------------------------------------

test('the chain window is live from the priming drop, not from the first rung', () => {
  // A running deadline the player cannot see is the one thing this bar exists to prevent.
  const bar = region('u-chain-meter');

  hud.setStats(stats({ chain: 0, chainFraction: 0 }));
  assert.equal(bar.hasAttribute('live'), false, 'nothing running, nothing shown');

  hud.setStats(stats({ chain: 1, chainFraction: 0.8 }));
  assert.equal(bar.hasAttribute('live'), true);
  assert.equal(bar.hasAttribute('priming'), true, 'a countdown rather than a stake');

  hud.setStats(stats({ chain: 3, chainFraction: 0.8 }));
  assert.equal(bar.hasAttribute('priming'), false, 'past priming once a rung is earned');
});

test('the window drains, goes critical, and stands its alarms down on the way out', () => {
  const bar = region('u-chain-meter');
  const fill = bar.shadowRoot.querySelector('i');

  hud.setStats(stats({ chain: 3, chainFraction: 0.5 }));
  assert.equal(fill.style.transform, 'scaleX(0.500)');

  hud.setStats(stats({ chain: 3, chainFraction: 0.05 }));
  assert.equal(bar.hasAttribute('critical'), true, 'a couple of frames left');

  hud.setStats(stats({ chain: 8, chainFraction: 0.5 }));
  assert.equal(bar.hasAttribute('hot'), true, 'deep in, the window is tightest');

  // Dropped on the way out, or the buzz and blink animations keep running on a bar nobody
  // can see.
  hud.setStats(stats({ chain: 0, chainFraction: 0 }));
  for (const gone of ['live', 'critical', 'hot', 'cursed', 'priming']) {
    assert.equal(bar.hasAttribute(gone), false, `${gone} outlived the chain`);
  }
});

test('a cursed combo stops the meter looking like the same meter', () => {
  const bar = region('u-chain-meter');
  // At the multiplier the mechanic actually opens on, rather than at a number picked here —
  // COMBO.CURSED_BASE is the threshold and it has moved before.
  hud.setStats(stats({ chain: 0, chainFraction: 0.5, cursedMult: COMBO.CURSED_BASE }));

  assert.equal(bar.hasAttribute('cursed'), true);
  assert.equal(bar.hasAttribute('live'), true, 'cursed is live even with no ordinary chain');

  hud.setStats(stats({ chain: 0, chainFraction: 0.5, cursedMult: COMBO.CURSED_BASE - 1 }));
  assert.equal(bar.hasAttribute('cursed'), false, 'and below the base it is not cursed at all');
});

// --- between stages -------------------------------------------------------------------

test('the cleared card comes up carrying what the stage paid', () => {
  hud.showCleared({ stage: 4, score: 12850.4, total: 41200 });

  assert.equal(region('u-interlude').hidden, false);
  assert.equal(part('u-interlude', '[data-el="stage"]').textContent, '4');

  // Rounded and grouped, the same as the HUD's own score readout.
  assert.equal(part('u-interlude', '[data-el="score"]').textContent, '12,850');
  assert.equal(part('u-interlude', '[data-el="total"]').textContent, '41,200');
});

test('a stage worth nothing still reads as a number rather than a blank', () => {
  hud.showCleared({ stage: 1, score: 0, total: 0 });
  assert.equal(part('u-interlude', '[data-el="score"]').textContent, '0');
  assert.equal(part('u-interlude', '[data-el="total"]').textContent, '0');
});

test('the controls live inside the modal, under the text', () => {
  // They used to float over the board below the panel, which is why they were sized to match
  // the HUD's icon buttons. Inside the panel they are ordinary panel buttons — and being
  // inside means the markup order is what puts them under the text rather than over it.
  const markup = read('src/ui/interlude/interlude.html');
  const headline = markup.indexOf('class="headline"');
  const actions = markup.indexOf('class="row actions"');

  assert.ok(headline > -1 && actions > headline, 'the buttons come after the card text');
  assert.ok(
    markup.indexOf('data-action="pause"') > actions &&
      markup.indexOf('data-action="play"') > actions,
    'and both of them are in that row',
  );
});

test('starting the stage is the green button, and says what it does', () => {
  // It is the way out of a wait, which makes it the thing the player is there to press —
  // and "Skip" described the mechanism rather than the outcome.
  const play = part('u-interlude', '[data-action="play"]');

  assert.equal(play.getAttribute('variant'), 'primary', 'the primary treatment is the green one');
  assert.match(play.textContent, /Play stage/, 'with a visible label saying so');
  assert.ok(!/Skip/.test(play.textContent), 'and nothing left calling it a skip');
});

test('the play icon is drawn rather than typed, and takes its colour from the button', () => {
  // Deliberately says nothing about how many paths the artwork uses — that changed once
  // already when the icon was swapped, and it was never the thing that mattered. What has to
  // hold is that it is inline SVG (a codepoint like ⏩ lands as a colour emoji on some
  // platforms and tofu on others) and that it paints with currentColor, which is the hook
  // the stylesheet uses to colour it.
  const play = part('u-interlude', '[data-action="play"]');
  const icon = play.querySelector('u-icon');
  assert.ok(icon, 'the button leads with an icon');

  const svg = icon.shadowRoot.querySelector('svg');
  assert.ok(svg, 'which is drawn, not typed');
  assert.ok(svg.getAttribute('viewBox'), 'with a viewBox, so it scales');
  assert.equal(svg.querySelector('path').getAttribute('fill'), 'currentColor',
    'the colour comes from the button, not the file');
  assert.ok(play.getAttribute('label'), 'and the button says what it is');
});

test('the same icon is one file, not two copies that can drift', () => {
  // The double arrow is on the CLEARED card and on every briefing, and the reload glyph was
  // pasted into three different buttons. Naming them is what stops two of them diverging.
  const catalogue = read('src/ui/icon/icon.html');
  const names = [...catalogue.matchAll(/data-icon="([a-z-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    [...new Set(names)].sort(),
    names.sort(),
    'each icon is defined exactly once',
  );

  const wanted = new Set();
  for (const file of ['interlude', 'briefing', 'game-over', 'settings', 'hud']) {
    for (const use of read(`src/ui/${file}/${file}.html`).matchAll(/<u-icon[^>]*name="([a-z-]+)"/g)) {
      wanted.add(use[1]);
    }
  }
  assert.ok(wanted.size >= 3, 'sanity: icon uses were parsed');
  const missing = [...wanted].filter((name) => !names.includes(name));
  assert.deepEqual(missing, [], `components ask for icons the catalogue lacks: ${missing}`);
});

test('the hold is a level behind the card, and it falls', () => {
  const timer = part('u-interlude', '[data-el="timer"]');

  hud.setCountdown(1);
  assert.equal(timer.style.transform, 'scaleY(1.000)', 'full at the start');

  hud.setCountdown(0.25);
  assert.equal(timer.style.transform, 'scaleY(0.250)');

  hud.setCountdown(0);
  assert.equal(timer.style.transform, 'scaleY(0.000)', 'and empty when it is up');
});

test('the hold bar is anchored at the bottom, so the level falls rather than rises', () => {
  // scaleY alone says nothing about which edge moves. Anchored anywhere else the tint
  // shrinks upward, which reads as filling — the exact opposite of counting down.
  const css = read('src/ui/interlude/interlude.scss');
  const rule = css.slice(css.indexOf('.timer i'));
  const body = rule.slice(rule.indexOf('{'), rule.indexOf('}'));

  assert.match(body, /transform-origin:[^;]*bottom/, 'the bottom edge is the one that stays');
  assert.match(body, /background:\s*var\(--white-10\)/, 'drawn in the shared 10% white token');
  assert.match(
    read('src/ui/tokens.scss'),
    /--white-10:\s*rgba\(255,\s*255,\s*255,\s*0\.1\)/,
    'which is what it says',
  );
});

test('a level written twice is only written to the DOM once', () => {
  // It is set every frame while a card is up. Rounded to the same three decimals it is the
  // same picture, and a transform re-written sixty times a second for it is sixty style
  // recalculations for nothing.
  const timer = part('u-interlude', '[data-el="timer"]');
  hud.setCountdown(0.5);
  timer.style.transform = 'touched';
  hud.setCountdown(0.5004);
  assert.equal(timer.style.transform, 'touched', 'no second write');
});

test('pausing relabels the button and marks the card', () => {
  const pause = part('u-interlude', '[data-action="pause"]');

  hud.setPaused(true);
  assert.equal(part('u-interlude', '[data-el="pause-label"]').textContent, 'Resume');
  assert.equal(pause.getAttribute('title'), 'Resume', 'and on hover');
  assert.equal(region('u-interlude').hasAttribute('paused'), true);
  assert.equal(pause.hasAttribute('held'), true, 'the button that did it says so');

  hud.setPaused(false);
  assert.equal(part('u-interlude', '[data-el="pause-label"]').textContent, 'Pause');
  assert.equal(region('u-interlude').hasAttribute('paused'), false);
  assert.equal(pause.hasAttribute('held'), false);

  // The button's own slot holds the two icons, so the label must never be written to the
  // button itself. That is the whole failure mode: `textContent =` deletes them, and the
  // button goes on working and reading correctly to a screen reader while being invisible.
  assert.ok(pause.querySelector('u-icon[name="pause"]'), 'the pause icon survived');
  assert.ok(pause.querySelector('u-icon[name="play"]'), 'and so did the play icon');
});

test('a held sequence is marked on the button that held it', () => {
  // Everything else in the modal expresses pause by not moving, which is indistinguishable
  // from a phase that is simply long. The stroke is the only thing saying held rather than
  // slow, so it has to be both coloured and alive. It lives on the button primitive now,
  // because "this control is holding something" is not a fact about the interlude.
  const css = read('src/ui/button/button.scss');
  const rule = css.match(/:host\(\[held\]\) \.btn \{([^}]*)\}/);

  assert.ok(rule, 'a held button must be reachable from the sheet');
  assert.match(rule[1], /border-color:\s*var\(--amber\)/, 'a yellow stroke');
  assert.match(rule[1], /animation:\s*held-breathe/, 'that breathes');
  assert.match(css, /@keyframes held-breathe/, 'and the pulse it names exists');

  // And the other side: something actually sets it.
  assert.match(read('src/ui/interlude/interlude.ts'), /\.held = paused/, 'the interlude sets it');
});

// --- briefings ---------------------------------------------------------------------------

test('a briefing opens one card and puts every other one away', () => {
  assert.equal(hud.showBriefing('cursed', { stage: 16, limit: 40000 }), true);

  assert.equal(region('u-briefing').hidden, false);
  assert.equal(part('u-briefing', '[data-el="stage"]').textContent, '16');
  assert.equal(part('u-briefing', '[data-brief="cursed"]').hidden, false);
  assert.equal(part('u-briefing', '[data-brief="clock"]').hidden, true);
  assert.equal(part('u-briefing', '[data-brief="riptear"]').hidden, true);

  hud.showBriefing('riptear', { stage: 30, limit: null });
  assert.equal(part('u-briefing', '[data-brief="riptear"]').hidden, false);
  assert.equal(part('u-briefing', '[data-brief="cursed"]').hidden, true, 'the last one is gone');
});

test('a card the markup does not have opens nothing at all', () => {
  // The stage -> card map lives in config.js and the cards live in briefing.html. A key with
  // no card must be a briefing that does not happen, not a stage load that throws.
  hud.hideBriefing();
  assert.equal(hud.showBriefing('nonesuch', { stage: 2 }), false);
  assert.equal(region('u-briefing').hidden, true);
});

test('the clock briefing quotes the deadline, in the units a briefing wants', () => {
  hud.showBriefing('clock', { stage: 1, limit: 72400 });

  assert.equal(part('u-briefing', '[data-el="clock-limit"]').textContent, '1:13');
  assert.equal(part('u-briefing', '[data-el="clock-timed"]').hidden, false);
  assert.equal(part('u-briefing', '[data-el="clock-untimed"]').hidden, true);
});

test('a briefing on an untimed stage does not invent a time limit', () => {
  // Stage 1 with no record anywhere is genuinely untimed, and a panel announcing a clock that
  // is not running is worse than no panel.
  hud.showBriefing('clock', { stage: 1, limit: null });

  assert.equal(part('u-briefing', '[data-el="clock-timed"]').hidden, true);
  assert.equal(part('u-briefing', '[data-el="clock-untimed"]').hidden, false);
  assert.equal(
    part('u-briefing', '[data-el="clock-limit"]').textContent,
    '∞',
    "and it says so in the HUD's own sign",
  );
});

test('the tenths the readout drops to are not a thing a briefing says', () => {
  // formatClock switches to a decimal inside the last five seconds, which is urgency rather
  // than information. A sentence about a clock wants "0:04", not "4.2".
  hud.showBriefing('clock', { stage: 1, limit: 4200 });
  assert.equal(part('u-briefing', '[data-el="clock-limit"]').textContent, '0:05');
});

test('the briefing panel is one door out, and it is the same green one', () => {
  const play = part('u-briefing', '[data-action="play"]');

  assert.ok(play, 'the briefing needs a way out');
  assert.equal(play.getAttribute('variant'), 'primary', 'the primary treatment, as on the card');
  assert.match(play.textContent, /Play stage/, 'saying the same thing it says there');
  assert.equal(
    play.querySelector('u-icon').getAttribute('name'),
    part('u-interlude', '[data-action="play"]').querySelector('u-icon').getAttribute('name'),
    'and carrying the same icon, because it is the same door',
  );
});

test('every briefing card config can ask for is one the panel has', () => {
  // The join between BRIEFING's keys and the cards. A key with no card is a briefing that
  // silently never opens, which is invisible until stage 16.
  const config = read('src/config.js');
  const stages = config.match(/STAGES:\s*\{([^}]*)\}/);
  const riptear = config.match(/RIP_AND_TEAR:\s*'([a-z]+)'/);
  assert.ok(stages && riptear, "BRIEFING should declare both its stage map and Rip & Tear's");

  const wanted = [...stages[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).concat(riptear[1]);
  assert.ok(wanted.length >= 3, 'sanity: the config side was parsed');

  const known = region('u-briefing').cards;
  assert.ok(known.length >= 3, 'sanity: the cards were found');
  const orphans = wanted.filter((key) => !known.includes(key));
  assert.deepEqual(orphans, [], `BRIEFING names cards the panel cannot open: ${orphans}`);
});

// --- what is covering the board ------------------------------------------------------------

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

  hud.showSettings();
  assert.equal(hud.settingsOpen, true);
  assert.equal(hud.anyOverlayOpen, true);
  hud.hideSettings();

  hud.showTitle({ maxStage: 1, total: 0 });
  assert.equal(hud.anyOverlayOpen, true, 'the title screen is one too');
  hud.hideTitle();
});

test('the title screen only boasts once there is something to boast about', () => {
  hud.showTitle({ maxStage: 1, total: 0 });
  assert.equal(part('u-title-screen', '[data-el="best"]').textContent, '',
    '"Best run: stage 1" is a player who has pressed Start once');

  hud.showTitle({ maxStage: 14, total: 92500 });
  assert.match(part('u-title-screen', '[data-el="best"]').textContent, /stage 14/);
  assert.match(part('u-title-screen', '[data-el="best"]').textContent, /92,500/);
  hud.hideTitle();
});

// --- settings -------------------------------------------------------------------------------

test('the settings toggles read and write real checkboxes', () => {
  hud.setOptions({ distinct: true, markers: false });
  const settings = region('u-settings');
  const box = (name) =>
    settings.shadowRoot
      .querySelector(`u-toggle[name="${name}"]`)
      .shadowRoot.querySelector('input');

  assert.equal(box('distinct').checked, true);
  assert.equal(box('markers').checked, false);

  hud.setOptions({ distinct: false, markers: true });
  assert.equal(box('distinct').checked, false);
  assert.equal(box('markers').checked, true);
});

test('a toggle reports the whole option set, not just the one that moved', () => {
  // `change` is composed: false, so a checkbox inside a shadow root fires an event nobody
  // outside ever hears. The component re-dispatches, and it sends both values — a caller
  // that has to remember which one just moved is a caller that will eventually forget.
  const seen = [];
  const settings = region('u-settings');
  settings.addEventListener('options', () => seen.push(settings.options));

  hud.setOptions({ distinct: false, markers: false });
  const input = settings.shadowRoot
    .querySelector('u-toggle[name="markers"]')
    .shadowRoot.querySelector('input');
  input.checked = true;
  input.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.deepEqual(seen, [{ distinct: false, markers: true }]);
});

// --- game over --------------------------------------------------------------------------

test('the game-over panel says which of the two ran out', () => {
  // The wording is free to change; which of the two ran out is not. The moves counter and the
  // clock sit at opposite ends of the HUD, and the panel is the only thing that says which
  // one just ended the run.
  hud.showGameOver({ stage: 12, knots: 3, reason: 'time' });
  assert.equal(part('u-game-over', '[data-el="stage"]').textContent, '12');
  assert.equal(part('u-game-over', '[data-el="reason"]').textContent, 'Out of time');
  assert.match(part('u-game-over', '[data-el="detail"]').textContent, /3 knots/, 'and how much was left');
  assert.match(part('u-game-over', '[data-el="detail"]').textContent, /clock/i, 'named as the clock');

  hud.showGameOver({ stage: 4, knots: 1, reason: 'moves' });
  assert.equal(part('u-game-over', '[data-el="reason"]').textContent, 'Out of moves');
  assert.match(part('u-game-over', '[data-el="detail"]').textContent, /1 knot\b/, 'singular, not "1 knots"');
  assert.match(part('u-game-over', '[data-el="detail"]').textContent, /moves/i, 'named as the moves');
  hud.hideGameOver();
});

// --- the buttons actually reach the game ---------------------------------------------------

test('every control on every panel reaches a handler', () => {
  // A listener bound to the wrong element, or an event named one thing and listened for
  // under another, fails completely silently: the button is there, it depresses, and
  // nothing happens.
  const fired = [];
  const handlers = new Proxy({}, { get: (_, name) => (...args) => fired.push([name, ...args]) });
  new Hud(handlers);

  const click = (tag, selector) =>
    part(tag, selector).shadowRoot.querySelector('button').dispatchEvent(
      new window.Event('click', { bubbles: true, composed: true }),
    );

  click('u-title-screen', '[data-action="start"]');
  click('u-title-screen', '[data-action="riptear"]');
  click('u-interlude', '[data-action="pause"]');
  click('u-interlude', '[data-action="play"]');
  click('u-briefing', '[data-action="play"]');
  click('u-game-over', '[data-action="retry"]');
  click('u-settings', '[data-action="restart"]');
  click('u-hud', '[data-action="restart-stage"]');

  assert.deepEqual(
    fired.map(([name]) => name),
    [
      'onStart',
      'onRipAndTear',
      'onPause',
      'onPlayStage',
      'onPlayStage',
      'onGameOverRetry',
      'onRestart',
      'onRestartStage',
    ],
  );
});

test('the settings button opens settings, and Done closes it again', () => {
  hud.hideSettings();
  part('u-hud', '[data-action="settings"]')
    .shadowRoot.querySelector('button')
    .dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
  assert.equal(hud.settingsOpen, true);

  part('u-settings', '[data-action="close"]')
    .shadowRoot.querySelector('button')
    .dispatchEvent(new window.Event('click', { bubbles: true, composed: true }));
  assert.equal(hud.settingsOpen, false, 'the panel closes itself; the game is not involved');
});

// --- the stylesheets know about all of it --------------------------------------------------

test('every attribute a component toggles has a rule in its own sheet', () => {
  // A renamed or mistyped attribute fails completely silently: the element gets it, the
  // stylesheet ignores it, and the state simply never shows. Scoped per component now,
  // which makes the check stronger than it was — the rule has to be in the sheet that
  // actually reaches the element, not merely somewhere in one global file.
  const components = ['chain-meter', 'interlude', 'stat', 'button', 'hud', 'briefing',
    'title-screen', 'game-over', 'settings', 'overlay', 'panel', 'toggle', 'icon'];

  let checked = 0;
  for (const name of components) {
    const source = read(`src/ui/${name}/${name}.ts`);
    const css = read(`src/ui/${name}/${name}.scss`);

    for (const [, attr] of source.matchAll(/toggleAttribute\(\s*'([a-z][a-z0-9-]*)'/g)) {
      assert.ok(css.includes(`[${attr}]`), `${name}.ts toggles [${attr}], unstyled in its sheet`);
      checked += 1;
    }
  }
  assert.ok(checked >= 6, `sanity: toggles were parsed (${checked})`);
});

test('every state the HUD gives a stat is one the stat sheet draws', () => {
  // The states are bare strings crossing a component boundary, which is exactly where a typo
  // survives review: `setState('burnin')` is valid code that quietly never lights up. Driven
  // rather than grepped, because that reads the states the HUD really produces.
  const css = read('src/ui/stat/stat.scss');
  const seen = new Set();

  for (const frame of [
    stats({ timeLeft: Infinity }),
    stats({ timeLeft: 8000 }),
    stats({ timeLeft: 1000 }),
    stats({ knots: 0 }),
    stats({ movesLeft: 0 }),
    stats({ movesLeft: 1 }),
    stats({ drawingFromBank: true }),
    stats({ bankFull: true }),
  ]) {
    hud.setStats(frame);
    for (const name of ['time', 'knots', 'movesLeft', 'bank', 'stage', 'score']) {
      if (state(name)) seen.add(state(name));
    }
  }

  assert.ok(seen.size >= 6, `sanity: states were produced (${[...seen]})`);
  const missing = [...seen].filter((s) => !css.includes(`state='${s}'`));
  assert.deepEqual(missing, [], `the HUD sets states stat.scss never draws: ${missing}`);
});

// --- hotkeys ------------------------------------------------------------------------------

/** A HUD whose handler calls are recorded, plus a way to press a key at it. */
function keyboardHud() {
  const fired = [];
  const handlers = new Proxy({}, { get: (_, name) => (...args) => fired.push([name, ...args]) });
  new Hud(handlers);
  return {
    fired,
    press: (key, opts = {}) =>
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key, ...opts })),
  };
}

/**
 * Puts focus where a browser would put it, for the duration of one call.
 *
 * Staged rather than focused, because happy-dom does not track focus across a shadow
 * boundary — and that boundary is the entire subject of the guard below. In a browser,
 * focusing a button inside `<u-button>` leaves `document.activeElement` reporting the host,
 * and only the host's shadow root knows the real `<button>` underneath.
 */
function withFocus(host, inner, fn) {
  const stage = (obj, value) =>
    Object.defineProperty(obj, 'activeElement', { value, configurable: true });

  stage(host.shadowRoot, inner);
  stage(window.document, host);
  try {
    fn();
  } finally {
    delete window.document.activeElement;
    delete host.shadowRoot.activeElement;
  }
}

test('Enter is the way past whatever is between you and the board', () => {
  const { fired, press } = keyboardHud();

  press('Enter');
  assert.deepEqual(fired, [['onPlayStage']]);
});

test('Enter does not fire the shortcut while a button has focus', () => {
  // Enter already activates a focused button. Hijacking it here would fire both, so tabbing
  // to PAUSE and pressing Enter would pause and start the stage in one keystroke. The catch
  // is that focus inside a shadow root reports as the *host* — `document.activeElement` is
  // the <u-button> — so the guard has to reach through to find the real button.
  const { fired, press } = keyboardHud();
  const pause = part('u-interlude', '[data-action="pause"]');

  withFocus(pause, pause.shadowRoot.querySelector('button'), () => {
    press('Enter');
    assert.deepEqual(fired, [], 'the button gets it, not the shortcut');
  });

  press('Enter');
  assert.deepEqual(fired, [['onPlayStage']], 'and it works again once focus is elsewhere');
});

test('the guard reaches through the shadow boundary to find the button', () => {
  // The failure this is really about: `document.activeElement` alone reports `<u-button>`,
  // whose tagName is not BUTTON, so a guard that stopped there would never stand down and
  // Enter would both activate the focused button and start the stage.
  const { fired, press } = keyboardHud();
  const pause = part('u-interlude', '[data-action="pause"]');

  // Focus on the host but nothing focused inside it — not a button, so Enter is the game's.
  withFocus(pause, null, () => {
    press('Enter');
    assert.deepEqual(fired, [['onPlayStage']], 'a host is not a button');
  });
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

test('R restarts the stage, and Escape shuts the settings panel', () => {
  const { fired, press } = keyboardHud();

  press('r');
  assert.deepEqual(fired.map(([name]) => name), ['onRestartStage']);

  hud.showSettings();
  press('Escape');
  assert.equal(hud.settingsOpen, false, 'Escape is the way out of a panel');
});
