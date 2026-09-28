import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { read, root } from './support/dom.js';

/**
 * The joins between the pieces, checked without running any of them.
 *
 * hud-render.test.js drives the real components in a real DOM. This is the other half: the
 * seams where two files have to agree about a name, and where disagreeing costs nothing at
 * import time and shows up as a control that quietly does nothing on stage 16.
 *
 * It used to be about one pair of files — index.html and hud.js. Now that the UI is a folder
 * per component the same checks generalise, and every one of them runs against every
 * component rather than against the one that happened to have the bug.
 */

const UI = join(root, 'src/ui');

/**
 * Every component folder. A new one is picked up here without being listed anywhere. The
 * two folders that are not components are the shared Sass partials and the typeface.
 */
const NOT_COMPONENTS = new Set(['shared', 'fonts']);
const components = readdirSync(UI, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !NOT_COMPONENTS.has(entry.name))
  .map((entry) => entry.name)
  .sort();

const source = (name) => read('src/ui', name, `${name}.ts`);
const markup = (name) => read('src/ui', name, `${name}.html`);
const sheet = (name) => read('src/ui', name, `${name}.scss`);

const html = read('index.html');
const hudSource = read('src/hud.ts');
const mainSource = read('src/main.ts');

test('sanity: the components were found', () => {
  assert.ok(components.length >= 12, `only found ${components}`);
});

// --- a component is three files and one tag ------------------------------------------------

test('every component is a folder of exactly the three files it should be', () => {
  for (const name of components) {
    const files = readdirSync(join(UI, name)).sort();
    assert.deepEqual(
      files,
      [`${name}.html`, `${name}.scss`, `${name}.ts`],
      `${name}/ should be its markup, its sheet and its class, named after the folder`,
    );
  }
});

test('every component registers one tag, and it is named after its folder', () => {
  // The folder name is the only index anyone has. A component defining `u-something-else`
  // is a file nobody will find from the markup that uses it.
  for (const name of components) {
    const defines = [...source(name).matchAll(/^define\('([a-z-]+)',/gm)].map((m) => m[1]);
    assert.deepEqual(defines, [`u-${name}`], `${name}.ts should define exactly u-${name}`);
  }
});

// --- a component's script and its markup agree ----------------------------------------------

/** Whether `selector` could match anything in `html`. Null for a shape not understood. */
function markupHas(html, selector) {
  const attr = selector.match(/^\[([a-z-]+)(?:="([^"]*)")?\]$/);
  if (attr) {
    return attr[2] === undefined ? html.includes(`${attr[1]}=`) : html.includes(`${attr[1]}="${attr[2]}"`);
  }

  const cls = selector.match(/^\.([a-z][a-z0-9_-]*)$/);
  if (cls) return new RegExp(`class="[^"]*\\b${cls[1]}\\b`).test(html);

  const tag = selector.match(/^([a-z][a-z0-9-]*)$/);
  if (tag) return html.includes(`<${tag[1]}`);

  return null;
}

test('every element a component reaches for exists in its own markup', () => {
  // `$()` throws on a miss, so this is already fatal at construction — but fatal at
  // construction means fatal on the stage that first mounts the thing. Here it is a
  // failing test on a file that was edited.
  let checked = 0;

  for (const name of components) {
    const code = source(name);
    const html = markup(name);

    for (const [, selector] of code.matchAll(/this\.(?:\$|all)(?:<[^>]+>)?\('([^']+)'\)/g)) {
      const found = markupHas(html, selector);
      assert.notEqual(found, null, `${name}.ts queries "${selector}", a shape this test cannot read`);
      assert.ok(found, `${name}.ts queries "${selector}", which ${name}.html has nothing for`);
      checked += 1;
    }
  }

  assert.ok(checked >= 20, `sanity: selectors were parsed (${checked})`);
});

test('every component a component uses is one it imports', () => {
  // Composition across shadow roots fails silently in the worst possible way: an unregistered
  // tag is not an error, it is an empty inline box. The panel renders, the button is simply
  // not there.
  for (const name of components) {
    const code = source(name);
    const used = new Set([...markup(name).matchAll(/<(u-[a-z-]+)/g)].map((m) => m[1]));

    for (const tag of used) {
      const folder = tag.slice(2);
      assert.ok(
        code.includes(`../${folder}/${folder}.ts`),
        `${name}.html mounts <${tag}> but ${name}.ts never imports it, so it will never upgrade`,
      );
    }
  }
});

// --- the page and the components agree -------------------------------------------------------

test('every tag in index.html is a component that exists', () => {
  const used = [...html.matchAll(/<(u-[a-z-]+)/g)].map((m) => m[1]);
  assert.ok(used.length >= 7, 'sanity: the page mounts the regions');

  for (const tag of new Set(used)) {
    assert.ok(components.includes(tag.slice(2)), `index.html mounts <${tag}>, which has no folder`);
  }
});

test('every region the Hud looks for is one the page mounts', () => {
  // `required()` throws, so a missing region is a game that does not boot at all — which is
  // the correct behaviour and a miserable way to find out.
  const wanted = [...hudSource.matchAll(/required[^(]*\('(u-[a-z-]+|#[a-z-]+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.length >= 7, `sanity: the Hud's regions were parsed (${wanted})`);

  for (const selector of wanted) {
    const needle = selector.startsWith('#') ? `id="${selector.slice(1)}"` : `<${selector}`;
    assert.ok(html.includes(needle), `hud.ts requires ${selector}, which index.html does not have`);
  }
});

test('the restart-stage button sits to the left of the settings button', () => {
  const bar = markup('hud');
  const restart = bar.indexOf('data-action="restart-stage"');
  const settings = bar.indexOf('data-action="settings"');

  assert.ok(restart > -1, 'the restart-stage button belongs in the HUD');
  assert.ok(settings > -1, 'and so does settings');
  assert.ok(restart < settings, 'restart comes first, so it renders to the left');
});

test('every readout the HUD writes to is one its markup declares', () => {
  // setStats indexes the stats by `data-stat`. A key with no element is `undefined.value =`,
  // which throws on the first frame of the first stage.
  const bar = markup('hud');
  const declared = new Set([...bar.matchAll(/data-stat="([A-Za-z]+)"/g)].map((m) => m[1]));

  const written = new Set(
    [...source('hud').matchAll(/#stats\.([A-Za-z]+)/g)].map((m) => m[1]),
  );
  assert.ok(written.size >= 6, `sanity: the readouts were parsed (${[...written]})`);

  const missing = [...written].filter((key) => !declared.has(key));
  assert.deepEqual(missing, [], `hud.ts writes stats hud.html does not declare: ${missing}`);
});

test('the settings toggles are wired to real inputs', () => {
  const panel = markup('settings');
  const declared = new Set([...panel.matchAll(/<u-toggle name="([a-z]+)"/g)].map((m) => m[1]));

  const readBack = new Set(
    [...source('settings').matchAll(/#toggles\.([a-z]+)/g)].map((m) => m[1]),
  );
  assert.ok(readBack.size >= 2, `sanity: the toggles were parsed (${[...readBack]})`);

  const missing = [...readBack].filter((name) => !declared.has(name));
  assert.deepEqual(missing, [], `settings.ts reads toggles the markup does not have: ${missing}`);

  // And that each one really is a checkbox rather than a styled div.
  assert.match(markup('toggle'), /<input type="checkbox"/, 'a toggle is a real checkbox');
});

// --- events reach somebody ---------------------------------------------------------------------

test('every event a component emits is one something listens for', () => {
  // The replacement for binding a handler straight onto a button: a component announces, and
  // whoever owns it decides. Announcing into an empty room is the new silent failure, and it
  // looks exactly like a button that does not work.
  const listeners = hudSource + components.map(source).join('\n');

  let emitted = 0;
  for (const name of components) {
    for (const [, type] of source(name).matchAll(/this\.emit\('([a-z-]+)'/g)) {
      assert.ok(
        listeners.includes(`addEventListener('${type}'`),
        `${name}.ts emits "${type}" and nothing listens for it`,
      );
      emitted += 1;
    }
  }

  assert.ok(emitted >= 8, `sanity: emits were parsed (${emitted})`);
});

test('every handler the Hud calls is one main.ts actually supplies', () => {
  // A renamed handler fails silently until someone clicks the thing: the listener is bound
  // either way, and `handlers.onWhatever is not a function` only lands at click time, on a
  // button that looks perfectly fine sitting there.
  const called = new Set([...hudSource.matchAll(/handlers\.(on[A-Za-z0-9]*)\(/g)].map((m) => m[1]));
  assert.ok(called.size >= 5, 'sanity: handler calls were parsed');

  const start = mainSource.indexOf('new Hud({');
  assert.ok(start > -1, 'main.ts should construct the Hud');
  const supplied = new Set(
    [...mainSource.slice(start).matchAll(/^ {2}(on[A-Za-z0-9]*):/gm)].map((m) => m[1]),
  );

  const missing = [...called].filter((name) => !supplied.has(name));
  assert.deepEqual(missing, [], `hud.ts calls handlers main.ts never passes: ${missing}`);

  // And the interface it is all typed against, so a new handler cannot be added on one side
  // only and still compile.
  for (const name of called) {
    assert.match(hudSource, new RegExp(`${name}\\(`), `HudHandlers should declare ${name}`);
  }
});

// --- the encapsulation is real ------------------------------------------------------------------

test('no component sheet reaches outside its own shadow root', () => {
  // The whole point of the split. An id selector in a component sheet is either dead — ids in
  // the page are not reachable from inside a shadow root — or a sign that markup which should
  // belong to the component is still sitting in index.html.
  for (const name of components) {
    const offenders = [...sheet(name).matchAll(/^\s*(#[a-z][a-z0-9-]*)/gm)].map((m) => m[1]);
    assert.deepEqual(offenders, [], `${name}.scss selects ${offenders} from outside itself`);
  }
});

test('the design tokens are the only global styling the components rely on', () => {
  // Custom properties inherit through a shadow boundary and class-based rules do not, which
  // is exactly the arrangement that makes a component safe to edit. A component pulling in
  // the token sheet would put a dead `:root` block inside its own shadow root.
  for (const name of components) {
    assert.ok(
      !sheet(name).includes('tokens'),
      `${name}.scss imports the tokens; it inherits them instead`,
    );
  }

  const tokens = read('src/ui/tokens.scss');
  const declared = new Set([...tokens.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
  assert.ok(declared.size >= 10, `sanity: tokens were parsed (${declared.size})`);

  const used = new Set();
  for (const name of components) {
    for (const [, token] of sheet(name).matchAll(/var\((--[a-z0-9-]+)\)/g)) used.add(token);
  }

  const undeclared = [...used].filter((token) => !declared.has(token));
  assert.deepEqual(undeclared, [], `components use tokens nothing defines: ${undeclared}`);
});

// --- the knobs the markup is derived from ----------------------------------------------------

test('the cursed briefing is keyed off the stage the cursed rope actually arrives', () => {
  // Two numbers that have to be the same number, and nothing would fail if they drifted: the
  // briefing would simply open on a stage with no black rope on it, or the black rope would
  // arrive unannounced. So the map is written in terms of the knob rather than in 16s.
  const config = read('src/config.js');
  const stages = config.match(/STAGES:\s*\{([^}]*)\}/);

  assert.ok(stages, 'BRIEFING.STAGES should be declared in config.js');
  assert.match(stages[1], /\[CURSED\.FROM\]:\s*'cursed'/, 'derived, not typed out');
  assert.ok(!/\b16\]?:\s*'cursed'/.test(stages[1]), 'and not a literal beside it');
});

test('nothing is left of the count that used to open every stage', () => {
  // It came out in one piece — the second card, the swipe between them, GO, and the phase
  // machine that drove all three. A leftover knob reads as a thing that still runs.
  const config = read('src/config.js');
  const game = read('src/game.js');
  const styles = [read('src/app.scss'), ...components.map(sheet)].join('\n');

  for (const gone of ['SWIPE_MS', 'COUNTDOWN_MS', 'GO_MS']) {
    assert.ok(!config.includes(`${gone}:`), `INTERLUDE.${gone} outlived the countdown`);
  }
  for (const gone of ['showCountdown', 'setGo']) {
    assert.ok(!hudSource.includes(`${gone}(`), `Hud.${gone} outlived the countdown`);
    assert.ok(!game.includes(`.${gone}(`), `game.js still calls ${gone}`);
  }
  for (const gone of ['swipe-out-left', 'swipe-in-right', 'interlude__card']) {
    assert.ok(!styles.includes(gone), `a stylesheet still carries ${gone}`);
  }
});

test('nothing is left of the single stylesheet the components replaced', () => {
  // styles.css and hud.js were one global sheet and one class that knew every id on the page.
  // A stray reference to either is a build that still half-expects them.
  for (const [where, text] of [
    ['index.html', html],
    ['main.ts', mainSource],
    ['hud.ts', hudSource],
  ]) {
    assert.ok(!text.includes('styles.css'), `${where} still references styles.css`);
    assert.ok(!/['"]\.\/hud\.js['"]/.test(text), `${where} still imports hud.js`);
  }

  // And the page carries no styling of its own any more — it is a canvas and seven tags.
  assert.ok(!html.includes('<style'), 'index.html should not carry a style block');
});
