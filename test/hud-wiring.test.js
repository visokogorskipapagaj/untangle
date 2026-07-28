import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const hudSource = readFileSync(join(root, 'src/hud.js'), 'utf8');

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

  const statKeys = ['stage', 'crossings', 'movesLeft', 'bank', 'distance', 'score'];
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

test('every button the HUD binds exists, and every overlay it toggles exists', () => {
  const buttons = [...hudSource.matchAll(/\$\('(btn-[A-Za-z0-9-]+)'\)/g)].map((m) => m[1]);
  assert.ok(buttons.length >= 6, 'sanity: buttons were parsed');
  for (const id of new Set(buttons)) {
    assert.ok(htmlIds.has(id), `hud.js binds #${id}, which index.html does not define`);
  }

  for (const id of ['overlay-title', 'overlay-solved', 'overlay-gameover', 'overlay-settings']) {
    assert.ok(htmlIds.has(id), `${id} must exist`);
  }
});
