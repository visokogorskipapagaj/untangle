import { CURSED, HEAVY, ROPE, STAGE } from './config.js';
import { clamp } from './geometry.js';
import { makeRng } from './rng.js';
import { growRope } from './rope.js';
import { moveBudgetFor } from './solver.js';
import { TangleTracker } from './tangle.js';

/** Rope count, crossing target and rope length for a stage. */
export function stageSpec(stage) {
  const ropeCount = Math.min(
    STAGE.ROPES_MAX,
    Math.floor(STAGE.ROPES_BASE + stage * STAGE.ROPES_PER_STAGE),
  );

  const wanted = STAGE.CROSSINGS_BASE + Math.floor(stage * STAGE.CROSSINGS_PER_STAGE);
  // Cap against what this many ropes can plausibly hold, or the generator spends its
  // whole budget chasing a target it can never reach.
  const targetCrossings = Math.min(wanted, Math.round(ropeCount * 2.5));

  const lengthFactor = Math.max(
    STAGE.LENGTH_MIN,
    STAGE.LENGTH_BASE - stage * STAGE.LENGTH_DECAY,
  );

  return { ropeCount, targetCrossings, lengthFactor };
}

export function playMargin(width, height) {
  return Math.max(12, Math.min(STAGE.MARGIN, Math.min(width, height) * 0.05));
}

/**
 * Builds a stage.
 *
 * Ropes are grown as random walks with angular momentum (exact segment lengths, natural
 * curves), scattered, then hill-climbed toward the target crossing count by nudging one
 * rope at a time. Hill-climbing beats plain rejection sampling here: hitting "exactly 18
 * crossings" by chance is vanishingly unlikely, but walking toward it is easy.
 *
 * Solvability is free in this game — ropes pass through each other and both ends are
 * loose, so any layout can be pulled apart as long as the ropes physically fit side by
 * side, which `fitsInViewport` checks.
 */
export function generateStage(stage, width, height, seed) {
  const rng = makeRng(seed);
  const spec = stageSpec(stage);
  const diagonal = Math.hypot(width, height);
  const baseLength = diagonal * spec.lengthFactor;
  const margin = playMargin(width, height);

  // Segment length is held constant across every rope in the stage. Rope size is then
  // expressed purely as node count, so a rope twice as long has twice the nodes — and
  // therefore costs twice the travel to haul, which is the honest reading of "distance
  // moved" when the metric is the sum of every node's displacement.
  const segLen = baseLength / (ROPE.NODES - 1);
  const sizes = [];
  for (let i = 0; i < spec.ropeCount; i++) {
    const size = rng.range(ROPE.SIZE_MIN, ROPE.SIZE_MAX);
    sizes.push(
      clamp(Math.round((baseLength * size) / segLen) + 1, ROPE.NODES_MIN, ROPE.NODES_MAX),
    );
  }

  let best = null;

  for (let attempt = 0; attempt < STAGE.MAX_LAYOUT_ATTEMPTS; attempt++) {
    const ropes = [];
    for (let i = 0; i < spec.ropeCount; i++) {
      ropes.push(spawnRope(i, segLen, sizes[i], rng, width, height, margin));
    }

    const tracker = new TangleTracker(ropes);
    hillClimb(ropes, tracker, spec.targetCrossings, rng, width, height, margin);

    const error = Math.abs(tracker.count - spec.targetCrossings);
    if (!best || error < best.error) {
      best = { ropes, tracker, error, crossings: tracker.count };
    }
    if (error === 0) break;
  }

  assignWeights(stage, best.ropes, best.tracker, rng);
  const weights = moveCosts(best.ropes, best.tracker);

  const difficulty =
    STAGE.TANGLE_W_CROSSINGS * best.crossings +
    STAGE.TANGLE_W_ROPES * spec.ropeCount +
    STAGE.TANGLE_W_PROXIMITY * best.tracker.proximityPressure(baseLength * 0.25);

  const totalLength = best.ropes.reduce((sum, rope) => sum + rope.length, 0);

  return {
    ropes: best.ropes,
    spec,
    crossings: best.crossings,
    // What the stage *should* cost: the cheapest set of ropes to relocate, widened by
    // slack. Weighted, so a heavy rope raises par honestly rather than underfunding it.
    moves: moveBudgetFor(
      spec.ropeCount,
      best.tracker.crossingEdges(),
      best.crossings,
      weights,
    ),
    weights,
    difficulty,
    baseLength,
    margin,
    fits: fitsInViewport(totalLength, width, height, margin),
  };
}

/**
 * Marks some ropes heavy.
 *
 * Weight is assigned *after* the layout settles, and only to ropes that actually cross
 * something — a heavy rope sitting alone in a corner is a decoration, not a decision.
 * Candidates are drawn from the more tangled half, so the expensive rope is usually one
 * the player would otherwise have reached for first.
 */
function assignWeights(stage, ropes, tracker, rng) {
  for (const rope of ropes) {
    rope.weight = 1;
    rope.cursed = false;
    rope.removed = false;
  }

  let doubles = stage < HEAVY.DOUBLE_FROM
    ? 0
    : 1 + Math.floor((stage - HEAVY.DOUBLE_FROM) / HEAVY.DOUBLE_EVERY);
  if (stage > HEAVY.LATE_FROM) {
    doubles += 1 + Math.floor((stage - HEAVY.LATE_FROM) / HEAVY.LATE_EVERY);
  }
  const triples = stage >= HEAVY.TRIPLE_FROM && rng.next() < HEAVY.TRIPLE_CHANCE ? 1 : 0;
  const cursed = stage >= CURSED.FROM ? 1 : 0;
  if (doubles + triples + cursed === 0) return;

  const degree = new Array(ropes.length).fill(0);
  for (const rec of tracker.pairs.values()) {
    degree[rec.i] += rec.count;
    degree[rec.j] += rec.count;
  }

  const candidates = ropes
    .map((rope, i) => ({ i, degree: degree[i] }))
    .filter((c) => c.degree > 0)
    .sort((a, b) => b.degree - a.degree);
  if (!candidates.length) return;

  const pool = candidates.slice(0, Math.max(1, Math.ceil(candidates.length * 0.6)));
  const share = stage > HEAVY.LATE_FROM ? HEAVY.LATE_MAX_SHARE : HEAVY.MAX_SHARE;

  // The cursed rope claims its slot first — it is the stage's centrepiece, and it has to
  // land on something tangled or its drag tax touches nothing.
  if (cursed && pool.length) {
    const pick = pool.splice(rng.int(0, pool.length - 1), 1)[0];
    ropes[pick.i].cursed = true;
    ropes[pick.i].weight = CURSED.GRAB_COST;
  }

  const slots = Math.max(0, Math.floor(ropes.length * share) - cursed);
  // Triples before doubles: with limited slots the rarer rope is worth spending them on.
  const tiers = [...Array(triples).fill(3), ...Array(doubles).fill(2)].slice(0, slots);
  for (const weight of tiers) {
    if (!pool.length) break;
    const pick = pool.splice(rng.int(0, pool.length - 1), 1)[0];
    ropes[pick.i].weight = weight;
  }
}

/**
 * What each rope costs to move, as the solver sees it at stage start.
 *
 * The cursed rope's drag tax is folded in here, so par is funded against what the board
 * actually charges. It is measured at stage start and therefore conservative: once a
 * rope is pulled clear of the cursed one its real cost drops, which can only help the
 * player.
 */
function moveCosts(ropes, tracker) {
  const cursed = ropes.findIndex((rope) => rope.cursed);
  return ropes.map((rope, i) => {
    if (rope.cursed) return CURSED.GRAB_COST;
    const taxed = cursed >= 0 && tracker.crossingsBetween(i, cursed) > 0;
    return rope.weight * (taxed ? CURSED.DRAG_TAX : 1);
  });
}

/** Grows a rope of the requested node count that fits the playfield, at a random spot. */
function spawnRope(id, segLen, nodeCount, rng, width, height, margin) {
  const availW = width - margin * 2;
  const availH = height - margin * 2;

  for (let tries = 0; tries < 40; tries++) {
    // Straighter ropes on later tries, so a cramped viewport still gets a rope.
    const curviness = tries < 30 ? 0.28 : 0.1;
    const rope = growRope(id, 0, 0, segLen, nodeCount, rng, curviness);
    const b = rope.bounds;
    const w = b.maxX - b.minX;
    const h = b.maxY - b.minY;
    if (w > availW || h > availH) continue;

    rope.translate(
      rng.range(margin, width - margin - w) - b.minX,
      rng.range(margin, height - margin - h) - b.minY,
    );
    return rope;
  }

  // Last resort: a nearly straight rope, nudged inside whatever room there is.
  const rope = growRope(id, width / 2, height / 2, segLen, nodeCount, rng, 0.02);
  keepInside(rope, width, height, margin);
  return rope;
}

/**
 * Nudges one rope at a time toward the target crossing count.
 * Equal-error moves are accepted so the search can cross plateaus instead of stalling.
 */
function hillClimb(ropes, tracker, target, rng, width, height, margin) {
  let error = Math.abs(tracker.count - target);
  const stepScale = Math.min(width, height) * 0.4;

  for (let iter = 0; iter < STAGE.MAX_ITERATIONS && error > 0; iter++) {
    const index = rng.int(0, ropes.length - 1);
    const rope = ropes[index];
    const saved = rope.saveState();

    // Too few crossings: pull this rope into the crowd. Too many: push it out.
    const centroid = layoutCentroid(ropes);
    const mid = rope.nodes[(rope.nodes.length / 2) | 0];
    const toward = tracker.count < target ? 1 : -1;
    let dx = centroid.x - mid.x;
    let dy = centroid.y - mid.y;
    const len = Math.hypot(dx, dy) || 1;
    const step = rng.range(0.05, 0.35) * stepScale;

    dx = (toward * dx / len) * step + rng.gauss() * step * 0.5;
    dy = (toward * dy / len) * step + rng.gauss() * step * 0.5;
    rope.translate(dx, dy);

    if (rng.next() < 0.3) {
      rope.rotate(rng.range(-0.9, 0.9));
      // A rotation can swell the bounding box past the playfield; translation cannot
      // rescue that, so undo it rather than leaving a rope half off-screen.
      const b = rope.bounds;
      if (b.maxX - b.minX > width - margin * 2 || b.maxY - b.minY > height - margin * 2) {
        rope.restoreState(saved);
        rope.translate(dx, dy);
      }
    }

    keepInside(rope, width, height, margin);
    tracker.recount(index);

    const next = Math.abs(tracker.count - target);
    if (next <= error) {
      error = next;
    } else {
      rope.restoreState(saved);
      tracker.recount(index);
    }
  }

  return error;
}

function layoutCentroid(ropes) {
  let x = 0;
  let y = 0;
  for (const rope of ropes) {
    const mid = rope.nodes[(rope.nodes.length / 2) | 0];
    x += mid.x;
    y += mid.y;
  }
  return { x: x / ropes.length, y: y / ropes.length };
}

/** Slides a rope back inside the playfield without deforming it. */
export function keepInside(rope, width, height, margin) {
  const b = rope.bounds;
  let dx = 0;
  let dy = 0;

  if (b.minX < margin) dx = margin - b.minX;
  else if (b.maxX > width - margin) dx = width - margin - b.maxX;
  if (b.minY < margin) dy = margin - b.minY;
  else if (b.maxY > height - margin) dy = height - margin - b.maxY;

  if (dx || dy) rope.translate(dx, dy);
}

/**
 * Can this many ropes of this length be laid out without touching? If not, the stage is
 * unwinnable no matter how well it is played. Treated as a guard, not a hard failure —
 * the caller shrinks ropes rather than refusing to start.
 */
export function fitsInViewport(totalRopeLength, width, height, margin) {
  const usable = (width - margin * 2) * (height - margin * 2);
  const footprint = totalRopeLength * ROPE.WIDTH * 3;
  return footprint < usable * 0.75;
}
