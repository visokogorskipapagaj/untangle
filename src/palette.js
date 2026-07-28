import { PALETTE } from './config.js';

/**
 * Rope colours for a stage.
 *
 * Stage 1 spreads hues across the full wheel; every stage after that multiplies the
 * spread by SPREAD_DECAY, so the ropes creep toward each other and telling them apart
 * becomes part of the difficulty. Lightness jitter shrinks in step — otherwise
 * brightness would keep doing the work that hue no longer does.
 *
 * `distinct` pins the spread wide open. Without that escape hatch the colour ramp locks
 * colourblind players out of the later stages entirely.
 */
export function stagePalette(stage, count, rng, distinct = false) {
  const spread = distinct
    ? PALETTE.SPREAD_START
    : Math.max(PALETTE.SPREAD_MIN, PALETTE.SPREAD_START * PALETTE.SPREAD_DECAY ** (stage - 1));

  const base = rng.range(0, 360);
  const narrowness = spread / PALETTE.SPREAD_START;
  const jitter = PALETTE.LIGHT_JITTER * narrowness;
  const colors = [];

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / count;
    const hue = (((base + (t - 0.5) * spread) % 360) + 360) % 360;
    const span = count === 1 ? 0 : i / (count - 1) - 0.5;
    const light = PALETTE.LIGHT + span * 2 * jitter;

    colors.push({
      hue,
      stroke: `hsl(${hue.toFixed(1)} ${PALETTE.SAT}% ${light.toFixed(1)}%)`,
      shade: `hsl(${hue.toFixed(1)} ${Math.round(PALETTE.SAT * 0.65)}% ${(light * 0.4).toFixed(1)}%)`,
      glow: `hsl(${hue.toFixed(1)} 100% 74%)`,
    });
  }

  return colors;
}

/** 0 = maximally distinct, 1 = fully converged. Shown as the stage's colour difficulty. */
export function colorConvergence(stage, distinct = false) {
  if (distinct) return 0;
  const spread = Math.max(
    PALETTE.SPREAD_MIN,
    PALETTE.SPREAD_START * PALETTE.SPREAD_DECAY ** (stage - 1),
  );
  return 1 - (spread - PALETTE.SPREAD_MIN) / (PALETTE.SPREAD_START - PALETTE.SPREAD_MIN);
}
