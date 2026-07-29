import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const hudSource = readFileSync(join(root, 'src/hud.js'), 'utf8');

const mainSource = readFileSync(join(root, 'src/main.js'), 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]));
const lookedUp = [...hudSource.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]);

/** The `this.el = { ... }` map, as raw source. */
function elementMapSource() {
  const start = hudSource.indexOf('this.el = {');
  assert.ok(start > -1, 'hud.js should build an element map');
  const end = hudSource.indexOf('\n    };', start);
  assert.ok(end > start, 'element map should be terminated');
  return hudSource.slice(start, end);
}

test('every element the HUD looks up exists in index.html', () => {
  assert.ok(lookedUp.length > 10, 'sanity: the HUD looks up a good number of elements');
  const missing = [...new Set(lookedUp)].filter((id) => !htmlIds.has(id));
  assert.deepEqual(missing, [], `hud.js queries ids absent from index.html: ${missing}`);
});

test('the element map has no duplicate keys', () => {
  // A duplicate silently wins, and this exact collision — `stage` resolving to the
  // page container instead of the stage-number span — made setStats write "1" into
  // the whole playfield on the first frame, blanking the canvas and every overlay.
  const keys = [...elementMapSource().matchAll(/^ {6}([A-Za-z][A-Za-z0-9]*):/gm)].map(
    (m) => m[1],
  );
  assert.ok(keys.length > 10, 'sanity: keys were actually parsed');

  const seen = new Set();
  const duplicates = keys.filter((key) => (seen.has(key) ? true : (seen.add(key), false)));
  assert.deepEqual(duplicates, [], `duplicate keys in this.el: ${duplicates}`);
});

test('no text-bearing stat key points at a layout container', () => {
  // setStats assigns textContent for each of these keys. Pointed at a container, that
  // erases the container's children.
  const containers = new Set(['stage', 'hud', 'canvas']);
  const map = elementMapSource();

  const statKeys = ['stage', 'time', 'knots', 'movesLeft', 'bank', 'score'];
  for (const key of statKeys) {
    const match = map.match(new RegExp(`^ {6}${key}: \\$\\('([A-Za-z0-9_-]+)'\\)`, 'm'));
    assert.ok(match, `setStats writes to this.el.${key}, so the map must define it`);
    assert.ok(
      !containers.has(match[1]),
      `this.el.${key} resolves to container #${match[1]} — writing textContent would blank it`,
    );
  }
});

test('the settings toggles are wired to real inputs', () => {
  for (const id of ['opt-distinct', 'opt-markers']) {
    assert.ok(htmlIds.has(id), `${id} must exist`);
    assert.ok(hudSource.includes(`$('${id}')`), `${id} must be wired in hud.js`);
  }
});

test('every handler the HUD calls is one main.js actually supplies', () => {
  // A renamed handler fails silently until someone clicks the thing: the listener is
  // bound either way, and `handlers.onWhatever is not a function` only lands at click
  // time, on a button that looks perfectly fine sitting there.
  const called = new Set(
    [...hudSource.matchAll(/handlers\.(on[A-Za-z0-9]*)\(/g)].map((m) => m[1]),
  );
  assert.ok(called.size >= 5, 'sanity: handler calls were parsed');

  const start = mainSource.indexOf('new Hud({');
  assert.ok(start > -1, 'main.js should construct the HUD');
  const supplied = new Set(
    [...mainSource.slice(start).matchAll(/^ {2}(on[A-Za-z0-9]*):/gm)].map((m) => m[1]),
  );

  const missing = [...called].filter((name) => !supplied.has(name));
  assert.deepEqual(missing, [], `hud.js calls handlers main.js never passes: ${missing}`);
});

test('the restart-stage button sits to the left of the settings button', () => {
  const right = html.slice(
    html.indexOf('hud__group--right'),
    html.indexOf('</header>'),
  );
  const restart = right.indexOf('id="btn-restart-stage"');
  const settings = right.indexOf('id="btn-settings"');

  assert.ok(restart > -1, 'the restart-stage button belongs in the right-hand HUD group');
  assert.ok(settings > -1, 'and so does settings');
  assert.ok(restart < settings, 'restart comes first, so it renders to the left');
});

test('every button the HUD binds exists, and every overlay it toggles exists', () => {
  const buttons = [...hudSource.matchAll(/\$\('(btn-[A-Za-z0-9-]+)'\)/g)].map((m) => m[1]);
  assert.ok(buttons.length >= 6, 'sanity: buttons were parsed');
  for (const id of new Set(buttons)) {
    assert.ok(htmlIds.has(id), `hud.js binds #${id}, which index.html does not define`);
  }

  const overlays = [
    'overlay-title',
    'overlay-interlude',
    'overlay-briefing',
    'overlay-gameover',
    'overlay-settings',
  ];
  for (const id of overlays) assert.ok(htmlIds.has(id), `${id} must exist`);
});

test('the cursed briefing is keyed off the stage the cursed rope actually arrives', () => {
  // Two numbers that have to be the same number, and nothing would fail if they drifted:
  // the briefing would simply open on a stage with no black rope on it, or the black rope
  // would arrive unannounced. So the map is written in terms of the knob rather than in 16s.
  const config = readFileSync(join(root, 'src/config.js'), 'utf8');
  const stages = config.match(/STAGES:\s*\{([^}]*)\}/);

  assert.ok(stages, 'BRIEFING.STAGES should be declared in config.js');
  assert.match(stages[1], /\[CURSED\.FROM\]:\s*'cursed'/, 'derived, not typed out');
  assert.ok(!/\b16\]?:\s*'cursed'/.test(stages[1]), 'and not a literal beside it');
});

test('nothing is left of the count that used to open every stage', () => {
  // It came out in one piece — the second card, the swipe between them, GO, and the phase
  // machine that drove all three. A leftover knob reads as a thing that still runs.
  const config = readFileSync(join(root, 'src/config.js'), 'utf8');
  const css = readFileSync(join(root, 'styles.css'), 'utf8');
  const game = readFileSync(join(root, 'src/game.js'), 'utf8');

  for (const gone of ['SWIPE_MS', 'COUNTDOWN_MS', 'GO_MS']) {
    assert.ok(!config.includes(`${gone}:`), `INTERLUDE.${gone} outlived the countdown`);
  }
  for (const gone of ['showCountdown', 'setGo']) {
    assert.ok(!hudSource.includes(`${gone}(`), `Hud.${gone} outlived the countdown`);
    assert.ok(!game.includes(`.${gone}(`), `game.js still calls ${gone}`);
  }
  for (const gone of ['swipe-out-left', 'swipe-in-right', 'interlude__card']) {
    assert.ok(!css.includes(gone), `the stylesheet still carries ${gone}`);
  }
});
