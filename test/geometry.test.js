import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nearestOnPolyline,
  pointSegDistance,
  polylineCrossings,
  polylineGap,
  segIntersection,
  segSegDistance,
} from '../src/geometry.js';

const pt = (x, y) => ({ x, y });

test('segIntersection: crossing segments meet at the expected point', () => {
  const hit = segIntersection(0, 0, 10, 10, 0, 10, 10, 0);
  assert.ok(hit);
  assert.equal(hit.x, 5);
  assert.equal(hit.y, 5);
});

test('segIntersection: parallel segments do not intersect', () => {
  assert.equal(segIntersection(0, 0, 10, 0, 0, 5, 10, 5), null);
});

test('segIntersection: collinear overlap reports no crossing', () => {
  // Overlapping collinear ropes have no single crossing point to resolve, and treating
  // them as crossing makes the count flicker.
  assert.equal(segIntersection(0, 0, 10, 0, 5, 0, 15, 0), null);
});

test('segIntersection: disjoint segments do not intersect', () => {
  assert.equal(segIntersection(0, 0, 1, 0, 5, 5, 6, 6), null);
});

test('segIntersection: an endpoint touching the other segment counts', () => {
  const hit = segIntersection(0, 0, 10, 0, 5, -5, 5, 0);
  assert.ok(hit);
  assert.equal(hit.x, 5);
  assert.equal(hit.y, 0);
  assert.equal(hit.u, 1);
});

test('segIntersection: segments whose infinite lines cross beyond their ends do not', () => {
  assert.equal(segIntersection(0, 0, 1, 1, 5, 0, 6, -1), null);
});

test('pointSegDistance: perpendicular and beyond-the-end cases', () => {
  assert.equal(pointSegDistance(5, 4, 0, 0, 10, 0), 4);
  assert.equal(pointSegDistance(-3, 0, 0, 0, 10, 0), 3);
  assert.equal(pointSegDistance(13, 0, 0, 0, 10, 0), 3);
  assert.equal(pointSegDistance(0, 0, 4, 4, 4, 4), Math.hypot(4, 4));
});

test('segSegDistance: zero when the segments cross', () => {
  assert.equal(segSegDistance(0, 0, 10, 10, 0, 10, 10, 0), 0);
});

test('segSegDistance: parallel offset and end-to-end gaps', () => {
  assert.equal(segSegDistance(0, 0, 10, 0, 0, 3, 10, 3), 3);
  assert.equal(segSegDistance(0, 0, 10, 0, 20, 0, 30, 0), 10);
  assert.ok(Math.abs(segSegDistance(0, 0, 10, 0, 13, 4, 20, 4) - 5) < 1e-9);
});

test('polylineCrossings: one crossing is reported once, at the right place', () => {
  const a = [pt(0, 0), pt(10, 0), pt(20, 0)];
  const b = [pt(5, -5), pt(5, 5)];
  const hits = polylineCrossings(a, b);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].x, 5);
  assert.equal(hits[0].y, 0);
});

test('polylineCrossings: a vertex landing on the other line is not double-counted', () => {
  // Passing exactly through a's vertex hits both of a's segments. That is one crossing.
  const a = [pt(0, 0), pt(10, 0), pt(20, 0)];
  const b = [pt(10, -5), pt(10, 5)];
  const hits = polylineCrossings(a, b);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].x, 10);
});

test('polylineCrossings: a genuine dip across and back stays two crossings', () => {
  const a = [pt(0, 0), pt(10, 0), pt(20, 0)];
  const b = [pt(5, -1), pt(9, 0.5), pt(13, -1)];
  assert.equal(polylineCrossings(a, b).length, 2);
});

test('polylineCrossings: a fold over a single segment is two crossings, not one', () => {
  // Both hits sit on a's segment 0 at b's segments 0 and 1 — index-adjacent, so index
  // adjacency alone would merge them. They are 10 apart, which is why the merge also
  // has to be a proximity test.
  const a = [pt(0, 0), pt(100, 0)];
  const b = [pt(20, -10), pt(30, 10), pt(40, -10)];

  const hits = polylineCrossings(a, b);
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => Math.round(h.x)).sort((x, y) => x - y),
    [25, 35],
  );

  // A merge radius wide enough to span them collapses the pair, proving the radius is
  // what discriminates a fold from a vertex artifact.
  assert.equal(polylineCrossings(a, b, 20).length, 1);
});

test('polylineCrossings: separated polylines report nothing', () => {
  const a = [pt(0, 0), pt(10, 0)];
  const b = [pt(0, 6), pt(10, 6)];
  assert.equal(polylineCrossings(a, b).length, 0);
});

test('polylineGap: measures the tightest separation, zero when crossing', () => {
  const a = [pt(0, 0), pt(10, 0)];
  assert.equal(polylineGap(a, [pt(0, 4), pt(10, 4)]), 4);
  assert.equal(polylineGap(a, [pt(5, -5), pt(5, 5)]), 0);
});

test('nearestOnPolyline: finds the closest node to a grab point', () => {
  const rope = [pt(0, 0), pt(10, 0), pt(20, 0), pt(30, 0)];
  const near = nearestOnPolyline(21, 3, rope);
  assert.equal(near.index, 2);
  assert.ok(Math.abs(near.distance - 3) < 1e-9);

  const end = nearestOnPolyline(31, 0, rope);
  assert.equal(end.index, 3);
});
