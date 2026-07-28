import { CURSED, HEAVY, ROPE } from './config.js';
import { boundsOf, clamp, smoothstep } from './geometry.js';

/**
 * A rope is a chain of nodes with a fixed segment length.
 *
 * The model is deliberately *kinematic*: there is no velocity, no gravity and no
 * integration step. A given drag always produces the same shape, which is what keeps
 * stages fair and the distance score honest. The only motion the rope makes on its own
 * is the short settle after release — and that motion is never scored.
 */
export class Rope {
  constructor(id, nodes, segLen) {
    this.id = id;
    this.nodes = nodes;
    this.segLen = segLen;
    this.color = null;
    /** Moves consumed by one drag. Heavy ropes cost 2 or 3. */
    this.weight = 1;
    /** The black rope: prohibitively expensive to move, taxes everything it touches. */
    this.cursed = false;
    /** Detonated by a x10 chain. Stays in the array so pair indices never shift. */
    this.removed = false;

    this._prev = nodes.map((n) => ({ x: n.x, y: n.y }));
    this._tmp = nodes.map((n) => ({ x: n.x, y: n.y }));
    this._bounds = null;
  }

  get length() {
    return this.segLen * (this.nodes.length - 1);
  }

  get strokeWidth() {
    if (this.cursed) return ROPE.WIDTH * CURSED.WIDTH_SCALE;
    return ROPE.WIDTH * (HEAVY.WIDTH_SCALE[this.weight] || 1);
  }

  get bounds() {
    if (!this._bounds) this._bounds = boundsOf(this.nodes);
    return this._bounds;
  }

  markDirty() {
    this._bounds = null;
  }

  // --- distance accounting ---------------------------------------------------

  /** Records current positions so `travelSinceSnapshot` can measure against them. */
  snapshot() {
    for (let i = 0; i < this.nodes.length; i++) {
      this._prev[i].x = this.nodes[i].x;
      this._prev[i].y = this.nodes[i].y;
    }
  }

  /**
   * Summed displacement of *every* node since the last snapshot — the game's
   * definition of "distance moved".
   */
  travelSinceSnapshot() {
    let total = 0;
    for (let i = 0; i < this.nodes.length; i++) {
      total += Math.hypot(this.nodes[i].x - this._prev[i].x, this.nodes[i].y - this._prev[i].y);
    }
    return total;
  }

  // --- manipulation ----------------------------------------------------------

  /**
   * Applies a pointer delta with a falloff around the grabbed node.
   *
   * Every node gets at least DRAG_BASE of the delta so the whole rope comes along —
   * that is what reads as "picking up a rope" rather than pinching a point — while
   * nodes near the grab get up to the full delta, giving the ends a slight lag.
   */
  drag(dx, dy, grabIndex) {
    const n = this.nodes;
    const spread = Math.max(1, n.length * ROPE.DRAG_SPREAD);
    const base = ROPE.DRAG_BASE;

    for (let i = 0; i < n.length; i++) {
      const w = base + (1 - base) * smoothstep(1 - Math.abs(i - grabIndex) / spread);
      n[i].x += dx * w;
      n[i].y += dy * w;
    }
    this.markDirty();
  }

  setNode(index, x, y) {
    this.nodes[index].x = x;
    this.nodes[index].y = y;
    this.markDirty();
  }

  /**
   * Jakobsen relaxation restoring the rest segment length. `pinIndex` (the grabbed
   * node) is treated as infinitely heavy so it stays glued to the pointer.
   * Passes alternate direction so the rope does not drift toward one end.
   */
  constrain(passes, pinIndex = -1) {
    const n = this.nodes;
    const last = n.length - 1;
    const L = this.segLen;

    for (let p = 0; p < passes; p++) {
      const forward = p % 2 === 0;
      for (let k = 0; k < last; k++) {
        const i = forward ? k : last - 1 - k;
        const a = n[i];
        const b = n[i + 1];

        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 1e-9) {
          // Fully collapsed pair: nudge along a fixed axis so the solve can proceed.
          dx = 1e-6;
          dy = 0;
          d = 1e-6;
        }

        const diff = (d - L) / d;
        const aPinned = i === pinIndex;
        const bPinned = i + 1 === pinIndex;
        if (aPinned && bPinned) continue;

        const wa = aPinned ? 0 : bPinned ? 1 : 0.5;
        const wb = bPinned ? 0 : aPinned ? 1 : 0.5;

        a.x += dx * diff * wa;
        a.y += dy * diff * wa;
        b.x -= dx * diff * wb;
        b.y -= dy * diff * wb;
      }
    }
    this.markDirty();
  }

  /** Laplacian smoothing. Endpoints and the pinned node hold still. */
  smooth(factor, pinIndex = -1) {
    const n = this.nodes;
    const t = this._tmp;
    for (let i = 0; i < n.length; i++) {
      t[i].x = n[i].x;
      t[i].y = n[i].y;
    }
    for (let i = 1; i < n.length - 1; i++) {
      if (i === pinIndex) continue;
      const mx = (t[i - 1].x + t[i + 1].x) * 0.5;
      const my = (t[i - 1].y + t[i + 1].y) * 0.5;
      n[i].x += (mx - n[i].x) * factor;
      n[i].y += (my - n[i].y) * factor;
    }
    this.markDirty();
  }

  /** Keeps the rope inside the playfield so it can never be dragged out of reach. */
  clampTo(width, height, margin) {
    for (const p of this.nodes) {
      p.x = clamp(p.x, margin, width - margin);
      p.y = clamp(p.y, margin, height - margin);
    }
    this.markDirty();
  }

  translate(dx, dy) {
    for (const p of this.nodes) {
      p.x += dx;
      p.y += dy;
    }
    this.markDirty();
  }

  /** Rotates around the rope's own midpoint. Used by the stage generator. */
  rotate(radians) {
    const mid = this.nodes[(this.nodes.length / 2) | 0];
    const cx = mid.x;
    const cy = mid.y;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    for (const p of this.nodes) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      p.x = cx + dx * cos - dy * sin;
      p.y = cy + dx * sin + dy * cos;
    }
    this.markDirty();
  }

  /**
   * Uniform scale plus offset, used on viewport resize. Scaling uniformly preserves
   * every crossing exactly, so a resize mid-stage cannot create or destroy work.
   */
  transform(scale, offsetX, offsetY) {
    for (const p of this.nodes) {
      p.x = p.x * scale + offsetX;
      p.y = p.y * scale + offsetY;
    }
    this.segLen *= scale;
    this.markDirty();
  }

  // --- save / restore (stage generation hill-climb) --------------------------

  saveState() {
    return this.nodes.map((p) => ({ x: p.x, y: p.y }));
  }

  restoreState(state) {
    for (let i = 0; i < this.nodes.length; i++) {
      this.nodes[i].x = state[i].x;
      this.nodes[i].y = state[i].y;
    }
    this.markDirty();
  }
}

/**
 * Builds a rope as a random walk with angular momentum: segment lengths are exact by
 * construction, and the accumulating turn rate produces natural rope-like curves
 * instead of the noise you get from perturbing points independently.
 */
export function growRope(id, startX, startY, segLen, nodeCount, rng, curviness = 0.28) {
  const nodes = [{ x: startX, y: startY }];
  let angle = rng.range(0, Math.PI * 2);
  let turn = 0;

  for (let i = 1; i < nodeCount; i++) {
    turn = clamp(turn + rng.gauss() * curviness, -0.42, 0.42);
    angle += turn;
    const prev = nodes[i - 1];
    nodes.push({ x: prev.x + Math.cos(angle) * segLen, y: prev.y + Math.sin(angle) * segLen });
  }

  return new Rope(id, nodes, segLen);
}

export const NODE_COUNT = ROPE.NODES;
