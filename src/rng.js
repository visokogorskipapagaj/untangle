/**
 * Seeded RNG. Every stage is generated from a seed so layouts are reproducible —
 * which makes `?seed=123&stage=7` a real debugging tool and lets a stage be shared.
 */

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixes a base seed with a stage number so stages differ but stay reproducible. */
export function hashSeed(base, n) {
  let h = (base ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ n, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function makeRng(seed) {
  const next = mulberry32(seed);
  return {
    next,
    /** Uniform in [min, max). */
    range: (min, max) => min + next() * (max - min),
    /** Integer in [min, max]. */
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** Approximately standard-normal, via the sum of 3 uniforms. */
    gauss: () => (next() + next() + next() - 1.5) * 1.1547,
    sign: () => (next() < 0.5 ? -1 : 1),
  };
}
