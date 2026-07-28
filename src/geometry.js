/**
 * Pure geometry primitives. No state, no DOM — this is the module the unit tests cover.
 */

const EPS = 1e-12;

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(t) {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

export function dist(ax, ay, bx, by) {
  return Math.hypot(bx - ax, by - ay);
}

/**
 * Proper intersection of segments AB and CD.
 * Returns {x, y, t, u} or null. Parallel and collinear pairs return null: two ropes
 * lying exactly on top of each other is not a crossing we can meaningfully resolve,
 * and treating it as one produces flickering counts.
 */
export function segIntersection(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;

  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < EPS) return null;

  const qpx = cx - ax;
  const qpy = cy - ay;
  const t = (qpx * sy - qpy * sx) / denom;
  if (t < 0 || t > 1) return null;
  const u = (qpx * ry - qpy * rx) / denom;
  if (u < 0 || u > 1) return null;

  return { x: ax + t * rx, y: ay + t * ry, t, u };
}

/** Squared distance from point P to segment AB, plus the closest-point parameter. */
export function pointSegDistSq(px, py, ax, ay, bx, by) {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  let t = 0;
  if (lenSq > EPS) {
    t = clamp(((px - ax) * abx + (py - ay) * aby) / lenSq, 0, 1);
  }
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  return { distSq: dx * dx + dy * dy, t };
}

export function pointSegDistance(px, py, ax, ay, bx, by) {
  return Math.sqrt(pointSegDistSq(px, py, ax, ay, bx, by).distSq);
}

/**
 * Minimum distance between segments AB and CD. Zero when they intersect.
 * For non-intersecting segments the minimum always occurs at an endpoint of one of
 * them, so four point-segment tests are exact.
 */
export function segSegDistance(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segIntersection(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.sqrt(
    Math.min(
      pointSegDistSq(ax, ay, cx, cy, dx, dy).distSq,
      pointSegDistSq(bx, by, cx, cy, dx, dy).distSq,
      pointSegDistSq(cx, cy, ax, ay, bx, by).distSq,
      pointSegDistSq(dx, dy, ax, ay, bx, by).distSq,
    ),
  );
}

/** Axis-aligned bounds of a node list, padded by `pad`. */
export function boundsOf(nodes, pad = 0) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x > maxX) maxX = n.x;
    if (n.y > maxY) maxY = n.y;
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

export function boundsOverlap(a, b) {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
}

/**
 * All intersections between two polylines, deduped into clusters.
 *
 * A vertex of one polyline landing on the other produces two (or four) segment-pair
 * hits for a single visual crossing, so index-adjacent hits are merged and reported
 * once. `mergeRadius` is the second half of that test: the artifact's hits sit on top
 * of each other, whereas a rope folded over another produces index-adjacent hits at
 * genuinely different places, and merging those would undercount real crossings.
 * Callers should pass a fraction of the segment length.
 */
export function polylineCrossings(a, b, mergeRadius = 1e-6) {
  const hits = [];
  const bBounds = boundsOf(b);

  for (let i = 0; i < a.length - 1; i++) {
    const a0 = a[i];
    const a1 = a[i + 1];
    const aMinX = Math.min(a0.x, a1.x);
    const aMaxX = Math.max(a0.x, a1.x);
    const aMinY = Math.min(a0.y, a1.y);
    const aMaxY = Math.max(a0.y, a1.y);
    if (aMaxX < bBounds.minX || aMinX > bBounds.maxX) continue;
    if (aMaxY < bBounds.minY || aMinY > bBounds.maxY) continue;

    for (let j = 0; j < b.length - 1; j++) {
      const b0 = b[j];
      const b1 = b[j + 1];
      if (aMaxX < Math.min(b0.x, b1.x) || aMinX > Math.max(b0.x, b1.x)) continue;
      if (aMaxY < Math.min(b0.y, b1.y) || aMinY > Math.max(b0.y, b1.y)) continue;

      const hit = segIntersection(a0.x, a0.y, a1.x, a1.y, b0.x, b0.y, b1.x, b1.y);
      if (hit) hits.push({ i, j, x: hit.x, y: hit.y });
    }
  }

  return clusterHits(hits, mergeRadius);
}

/** Merges index-adjacent hits until stable, returning one point per real crossing. */
function clusterHits(hits, mergeRadius) {
  if (hits.length < 2) {
    return hits.map((h) => ({ x: h.x, y: h.y }));
  }

  const groups = hits.map((h) => [h]);
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let g = 0; g < groups.length; g++) {
      for (let h = g + 1; h < groups.length; h++) {
        if (groupsAdjacent(groups[g], groups[h], mergeRadius)) {
          groups[g] = groups[g].concat(groups[h]);
          groups.splice(h, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  return groups.map((group) => {
    let x = 0;
    let y = 0;
    for (const h of group) {
      x += h.x;
      y += h.y;
    }
    return { x: x / group.length, y: y / group.length };
  });
}

/**
 * Two hits belong to the same crossing when they share a segment index, neighbour on
 * the other axis, *and* land in the same place — the signature of a polyline vertex
 * sitting on the other line, which registers one visual crossing as two or four hits.
 *
 * Both halves are load-bearing. Index adjacency alone merges a rope folded over another
 * (two real crossings on one segment, at different points) into one, undercounting the
 * board. Proximity alone would merge unrelated crossings that happen to be near.
 */
function groupsAdjacent(g1, g2, mergeRadius) {
  for (const a of g1) {
    for (const b of g2) {
      const di = Math.abs(a.i - b.i);
      const dj = Math.abs(a.j - b.j);
      const indexAdjacent = (di === 0 && dj <= 1) || (dj === 0 && di <= 1);
      if (indexAdjacent && Math.hypot(a.x - b.x, a.y - b.y) <= mergeRadius) return true;
    }
  }
  return false;
}

/** Smallest gap between two polylines. Zero if they cross. */
export function polylineGap(a, b) {
  let best = Infinity;
  for (let i = 0; i < a.length - 1; i++) {
    for (let j = 0; j < b.length - 1; j++) {
      const d = segSegDistance(
        a[i].x, a[i].y, a[i + 1].x, a[i + 1].y,
        b[j].x, b[j].y, b[j + 1].x, b[j + 1].y,
      );
      if (d < best) {
        best = d;
        if (best === 0) return 0;
      }
    }
  }
  return best;
}

/** Distance from a point to a polyline, plus the index of the nearest node. */
export function nearestOnPolyline(px, py, nodes) {
  let bestDistSq = Infinity;
  let bestIndex = 0;

  for (let i = 0; i < nodes.length - 1; i++) {
    const { distSq, t } = pointSegDistSq(
      px, py, nodes[i].x, nodes[i].y, nodes[i + 1].x, nodes[i + 1].y,
    );
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestIndex = t < 0.5 ? i : i + 1;
    }
  }

  return { distance: Math.sqrt(bestDistSq), index: bestIndex };
}
