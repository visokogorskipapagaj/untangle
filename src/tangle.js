import { boundsOverlap, polylineCrossings, polylineGap } from './geometry.js';

const pairKey = (i, j) => `${i}:${j}`;

/** Two hits merge only if they are this close, relative to segment length. */
const MERGE_FRACTION = 0.35;

/**
 * Tracks which ropes cross which, and turns changes into *untangle events*.
 *
 * Counting and awarding are deliberately separate:
 *
 *  - `recount(i)` runs on every frame of a drag and just refreshes the geometry. Only
 *    one rope moves at a time, so only pairs touching it can change — checking 13 pairs
 *    instead of 91 is what keeps drag frames cheap.
 *  - `commit()` runs once, when the gesture ends, and is the only thing that awards.
 *
 * That split is what makes scoring honest. Awarding per frame paid out for momentary
 * separations mid-whip (a rope could end up *more* tangled and still bank points), and
 * made a gesture's value depend on where frame boundaries happened to fall. One gesture
 * is one move, so one gesture gets one evaluation.
 *
 * The ratchet is the other half: a pair pays out only when its count drops below the
 * lowest it has *ever* been, so re-tangling ropes and pulling them apart earns nothing.
 */
export class TangleTracker {
  constructor(ropes) {
    this.ropes = ropes;
    this.pairs = new Map();
    this.reset();
  }

  reset() {
    this.pairs.clear();
    for (let i = 0; i < this.ropes.length; i++) {
      for (let j = i + 1; j < this.ropes.length; j++) {
        const points = this._crossings(i, j);
        this.pairs.set(pairKey(i, j), {
          i,
          j,
          points,
          count: points.length,
          minSeen: points.length,
          marked: points.length,
        });
      }
    }
  }

  _crossings(i, j) {
    const a = this.ropes[i];
    const b = this.ropes[j];
    // A detonated rope stays in the array so pair indices never shift, but it is off the
    // board and crosses nothing.
    if (a.removed || b.removed) return [];
    if (!boundsOverlap(a.bounds, b.bounds)) return [];
    const mergeRadius = Math.min(a.segLen, b.segLen) * MERGE_FRACTION;
    return polylineCrossings(a.nodes, b.nodes, mergeRadius);
  }

  /**
   * Records the board as it stands at the start of a gesture, so `createdSinceMark` can
   * tell what that one move actually cost.
   */
  mark() {
    for (const rec of this.pairs.values()) rec.marked = rec.count;
  }

  /**
   * New knots this gesture put on the board — the player parking a rope on top of
   * another one. Counted against the mark rather than the all-time low, because making a
   * fresh knot is a fact about *this* move, not about the stage's history.
   */
  createdSinceMark() {
    let created = 0;
    for (const rec of this.pairs.values()) {
      if (rec.count > rec.marked) created += rec.count - rec.marked;
    }
    return created;
  }

  /** Refreshes every pair touching `movedIndex`. Never awards, never ratchets. */
  recount(movedIndex) {
    for (let k = 0; k < this.ropes.length; k++) {
      if (k === movedIndex) continue;
      const rec = this.pairs.get(pairKey(Math.min(k, movedIndex), Math.max(k, movedIndex)));
      if (!rec) continue;
      rec.points = this._crossings(rec.i, rec.j);
      rec.count = rec.points.length;
    }
  }

  /** Refreshes everything, without awarding. Used after a viewport change. */
  recountAll() {
    for (const rec of this.pairs.values()) {
      rec.points = this._crossings(rec.i, rec.j);
      rec.count = rec.points.length;
    }
  }

  /**
   * Closes out a gesture: ratchets each pair's low-water mark and reports what was
   * genuinely resolved.
   *
   * `gap` is only measured once a pair is completely separated — while they still cross
   * somewhere else the minimum distance is zero, which would otherwise read as a perfect
   * tightness bonus. Scoring treats a null gap as neutral.
   */
  commit() {
    const events = [];

    for (const rec of this.pairs.values()) {
      if (rec.count >= rec.minSeen) continue;

      const resolved = rec.minSeen - rec.count;
      rec.minSeen = rec.count;
      events.push({
        i: rec.i,
        j: rec.j,
        resolved,
        gap: rec.count === 0 ? polylineGap(this.ropes[rec.i].nodes, this.ropes[rec.j].nodes) : null,
      });
    }

    return events;
  }

  /** Crossings this one rope is currently involved in, against the whole board. */
  knotsFor(index) {
    let total = 0;
    for (const rec of this.pairs.values()) {
      if (rec.i === index || rec.j === index) total += rec.count;
    }
    return total;
  }

  /** Crossings between two specific ropes right now. */
  knotsBetween(i, j) {
    if (i === j) return 0;
    const rec = this.pairs.get(pairKey(Math.min(i, j), Math.max(i, j)));
    return rec ? rec.count : 0;
  }

  /** Total knots left on the board. Zero means the stage is solved. */
  get count() {
    let total = 0;
    for (const rec of this.pairs.values()) total += rec.count;
    return total;
  }

  /**
   * The knot graph as an edge list — one edge per knotted rope pair. This is what
   * the minimum-vertex-cover solver consumes to work out the stage's ideal move count.
   */
  knotEdges() {
    const edges = [];
    for (const rec of this.pairs.values()) {
      if (rec.count > 0) edges.push([rec.i, rec.j]);
    }
    return edges;
  }

  /** Every remaining knot, for the markers the renderer draws. */
  collectPoints(out = []) {
    out.length = 0;
    for (const rec of this.pairs.values()) {
      for (const p of rec.points) out.push(p);
    }
    return out;
  }

  /** Sum of 1/gap over all pairs — the proximity component of the tangliness rating. */
  proximityPressure(refPx) {
    let total = 0;
    for (const rec of this.pairs.values()) {
      const gap = rec.count > 0 ? 0 : polylineGap(this.ropes[rec.i].nodes, this.ropes[rec.j].nodes);
      total += refPx / Math.max(gap, refPx * 0.05);
    }
    return total;
  }
}
