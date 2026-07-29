import { MOVES } from './config.js';

/**
 * How many moves a stage *should* take.
 *
 * A gesture drags one rope, ropes pass through each other freely, and a rope can be
 * relocated anywhere in one continuous drag. So a rope moved into open space crosses
 * nothing, and the fewest moves that can solve a stage is the smallest set of ropes
 * whose removal leaves the rest crossing-free.
 *
 * That is exactly **minimum vertex cover** on the knot graph: ropes are vertices,
 * a knotted pair is an edge, and what remains after removing a cover is by definition
 * an independent set — no two ropes crossing.
 *
 * NP-hard in general, trivial here: branch-and-bound over bitmasks is exact and
 * instantaneous at the 3-14 ropes a stage ever holds.
 */

const popcount = (x) => {
  let n = x - ((x >> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >> 24;
};

/**
 * Exact minimum vertex cover, weighted.
 *
 * `weights[v]` is what moving rope v costs — 1 for a normal rope, more for a heavy one.
 * Unweighted, the answer is the *fewest* ropes to relocate; weighted, it is the
 * *cheapest* set, which is often a different and larger set of lighter ropes.
 *
 * The active set is a bitmask, so the vertex count is bounded by the 32 bits JavaScript's
 * bitwise operators coerce to. STAGE.ROPES_CEILING is 28, well inside it, and the throw
 * below is what makes that a checked assumption rather than a silent wrong answer: past
 * 32, `1 << v` wraps around and starts aliasing other vertices.
 *
 * @param {number} vertexCount up to 32
 * @param {Array<[number, number]>} edges
 * @param {number[]|null} weights per-vertex move cost; null means all 1
 */
export function minimumVertexCover(vertexCount, edges, weights = null) {
  if (vertexCount > 32) {
    throw new RangeError(`minimumVertexCover: ${vertexCount} vertices exceeds the 32-bit mask`);
  }
  if (vertexCount <= 0 || edges.length === 0) return 0;

  const costOf = (v) => (weights ? weights[v] : 1);

  const adjacency = new Array(vertexCount).fill(0);
  for (const [i, j] of edges) {
    if (i === j) continue;
    adjacency[i] |= 1 << j;
    adjacency[j] |= 1 << i;
  }

  // Covering everything is always valid, so it is a safe starting bound.
  let best = 0;
  for (let v = 0; v < vertexCount; v++) best += costOf(v);

  const search = (active, size) => {
    if (size >= best) return;

    // Highest-degree vertex among those still in play. Branching on it collapses the
    // search fastest, because the exclude-branch then removes many vertices at once.
    let pick = -1;
    let bestDegree = 0;
    for (let v = 0; v < vertexCount; v++) {
      if (!(active & (1 << v))) continue;
      const degree = popcount(adjacency[v] & active);
      if (degree > bestDegree) {
        bestDegree = degree;
        pick = v;
      }
    }

    if (bestDegree === 0) {
      best = size; // No edges left, so `size` is a complete cover.
      return;
    }

    // Either the vertex is in the cover...
    search(active & ~(1 << pick), size + costOf(pick));

    // ...or it is not, in which case every one of its neighbours must be.
    const neighbours = adjacency[pick] & active;
    let neighbourCost = 0;
    for (let v = 0; v < vertexCount; v++) {
      if (neighbours & (1 << v)) neighbourCost += costOf(v);
    }
    search(active & ~(1 << pick) & ~neighbours, size + neighbourCost);
  };

  search((1 << vertexCount) - 1 || -1, 0);
  return best;
}

/**
 * The stage's move budget.
 *
 * `ideal` is the true minimum widened by MOVES.SLACK, so par is demanding but humanly
 * reachable rather than requiring provably optimal play. `bonus` is the knot-count
 * cushion. Their sum is what the player is granted; the leftover banks.
 */
export function moveBudgetFor(ropeCount, edges, knots, weights = null) {
  const cover = minimumVertexCover(ropeCount, edges, weights);
  const ideal = Math.max(1, Math.ceil(cover * MOVES.SLACK));
  const bonus =
    MOVES.KNOTS_PER_BONUS > 0 ? Math.floor(knots / MOVES.KNOTS_PER_BONUS) : 0;
  return { cover, ideal, bonus, budget: ideal + bonus };
}
