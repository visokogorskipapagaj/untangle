import { CLOCK, COMBO, COMBO_HUD, ROPE } from './config.js';
import { clamp } from './geometry.js';

/**
 * The single combo slot, directly under the decay bar.
 *
 * The live indicator and the payout occupy the same place and never show at once: while a
 * run is going it is the knot count and the running total, and the instant it ends the
 * payout replaces it there. Two separate callouts meant the same number appeared twice.
 *
 * The geometry lives in config so the game can aim flying knot scores at the same total
 * this draws — see COMBO_HUD.
 */
const { ORIGIN_Y, TOTAL_DY, NAME_DY, BANNER_Y } = COMBO_HUD;

/** The face every number in the interface is set in; the canvas readouts match the HUD. */
const DISPLAY = '"Bricolage Grotesque", ui-rounded, ui-sans-serif, system-ui, sans-serif';

/** Height of the hop the cursed readout takes each time the multiplier climbs. */
const CURSED_HOP_PX = 11;

/** The red the board goes as the clock runs out. Alpha is the panic ramp's to set. */
const PANIC_RGB = '196, 26, 20';

/**
 * Canvas renderer.
 *
 * Ropes are drawn as their raw polyline with round joins and caps — not as a smoothed
 * spline. That keeps what the player sees geometrically identical to what the crossing
 * detector tests, so a hairline gap never looks like a crossing (or vice versa).
 */
export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    /**
     * Live, because `matches` is read fresh on every frame that would shake — the player
     * can turn this on mid-run and it takes effect on the next one. The stylesheet already
     * stands the shudder and the pause pulse down for the same preference; the endgame
     * shake is the one piece of sustained motion that is not the stylesheet's to switch
     * off, so it has to ask here.
     */
    this.calmly = globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
  }

  resize(cssWidth, cssHeight) {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.width = cssWidth;
    this.height = cssHeight;
    this.canvas.width = Math.round(cssWidth * this.dpr);
    this.canvas.height = Math.round(cssHeight * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  draw(state) {
    const { ctx } = this;
    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.#background(state.panic || 0, state.time);

    // Everything above the background shakes together in the last few seconds — the ropes,
    // the markers, the combo readout, the lot. The background is deliberately outside it:
    // it is a full-bleed fill, and shaking it would drag its own edge into frame and leave
    // a bare strip down one side of the board.
    //
    // The HUD is DOM and is left alone on purpose. It carries the clock, which is the one
    // thing the player needs to be able to read while this is happening.
    this.#shake(state.shake || 0, state.time);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    for (const rope of state.ropes) {
      if (rope.removed || rope.id === state.grabbedId) continue;
      this.#rope(rope, false, state.time);
    }

    // The held rope renders last so it is never buried under the ones it is being
    // pulled past — that readability is the whole point of holding it.
    const held = state.ropes.find((r) => r.id === state.grabbedId && !r.removed);
    if (held) this.#rope(held, true, state.time);

    if (state.showMarkers && state.knots.length) {
      this.#knotMarkers(state.knots, state.time);
    }

    if (state.explosions && state.explosions.length) this.#explosions(state.explosions);
    this.#chain(state);
    if (state.flashes && state.flashes.length) this.#flashes(state.flashes);
    if (state.banner) this.#banner(state.banner);

    if (state.debug) this.#debug(state);

    ctx.restore();
  }

  #background(panic = 0, time = 0) {
    const { ctx } = this;
    ctx.fillStyle = '#0a0d13';
    ctx.fillRect(0, 0, this.width, this.height);

    const g = ctx.createRadialGradient(
      this.width * 0.5, this.height * 0.45, 0,
      this.width * 0.5, this.height * 0.45, Math.max(this.width, this.height) * 0.75,
    );
    g.addColorStop(0, 'rgba(64, 84, 122, 0.16)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);

    if (panic > 0) this.#panicWash(panic, time);
  }

  /**
   * The board going red as the clock runs out — a second radial gradient laid straight over
   * the one above, and pointed the other way.
   *
   * The one underneath is brightest in the middle, because the middle is where the board
   * is. This one is *weakest* there and strongest at the edges, so the colour closes in
   * from the frame rather than settling on the puzzle. That is not decoration: the player
   * is expected to still clear this stage, and a flat red over the ropes is the alarm
   * making the thing it is warning about harder to do.
   *
   * It breathes, and it breathes faster the further gone the clock is. A tint held at a
   * fixed value reads as a filter somebody left on; the same tint moving reads as an alarm.
   */
  #panicWash(panic, time) {
    const { ctx } = this;
    // Between about a second and a half and half a second a beat, which is a pulse rate
    // rather than a flicker — it must never be mistaken for the screen malfunctioning.
    const beat = 0.5 + 0.5 * Math.sin(time * (0.004 + panic * 0.008));
    const peak = CLOCK.PANIC_ALPHA * panic * (0.82 + beat * 0.18);

    const g = ctx.createRadialGradient(
      this.width * 0.5, this.height * 0.45, 0,
      this.width * 0.5, this.height * 0.45, Math.max(this.width, this.height) * 0.72,
    );
    g.addColorStop(0, `rgba(${PANIC_RGB}, ${(peak * CLOCK.PANIC_CORE).toFixed(4)})`);
    // The knee, not a midpoint: without it the ramp from core to edge is linear across the
    // whole board and the strong end only exists in the corners, where nobody is looking.
    g.addColorStop(0.55, `rgba(${PANIC_RGB}, ${(peak * 0.55).toFixed(4)})`);
    g.addColorStop(1, `rgba(${PANIC_RGB}, ${peak.toFixed(4)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  /**
   * The last few seconds, felt rather than read.
   *
   * Two incommensurate sines per axis, the same trick the cursed readout uses and for the
   * same reason: a single sine is a rhythm, and the eye tunes a rhythm out within a second
   * or two. The weights on each pair sum to 1, so SHAKE_PX is exactly the furthest it ever
   * travels from centre.
   *
   * It moves the drawing and not the model, so a rope is up to SHAKE_PX from where the
   * pointer thinks it is. Against a grab radius of 22px that is well inside the tolerance
   * the game already allows, and being slightly harder to grab at four seconds left is the
   * intended effect rather than a cost of it.
   */
  #shake(intensity, time) {
    // The wash carries the same news in a form nobody has to brace for, so standing this
    // down costs the player no information at all.
    if (intensity <= 0 || this.calmly?.matches) return;
    const amp = CLOCK.SHAKE_PX * intensity;
    this.ctx.translate(
      (Math.sin(time * 0.071) * 0.62 + Math.sin(time * 0.163) * 0.38) * amp,
      (Math.cos(time * 0.089) * 0.58 + Math.sin(time * 0.197) * 0.42) * amp,
    );
  }

  #rope(rope, held, time = 0) {
    const { ctx } = this;
    const color = rope.color || { stroke: '#9fb4d8', shade: '#2b3547', glow: '#cfe2ff' };
    const nodes = rope.nodes;
    const width = rope.strokeWidth;

    ctx.beginPath();
    ctx.moveTo(nodes[0].x, nodes[0].y);
    for (let i = 1; i < nodes.length; i++) ctx.lineTo(nodes[i].x, nodes[i].y);

    if (rope.cursed) {
      this.#cursedRope(rope, held, time, width);
      return;
    }

    // Dark casing first: gives the rope an edge so overlapping ropes stay legible.
    ctx.strokeStyle = color.shade;
    ctx.lineWidth = width + 5;
    ctx.stroke();

    if (held) {
      ctx.save();
      ctx.shadowColor = color.glow;
      ctx.shadowBlur = 18;
    }

    ctx.strokeStyle = color.stroke;
    ctx.lineWidth = width;
    ctx.stroke();

    if (held) ctx.restore();

    // Heavy ropes get whipped binding across them. Thickness alone carries the cost, but
    // the banding survives the late-stage colour convergence, when every rope is nearly
    // the same hue and silhouette is all the player has left to read.
    if (rope.weight > 1) {
      ctx.save();
      ctx.setLineDash(rope.weight >= 3 ? [3, 7] : [3, 11]);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.32)';
      ctx.lineWidth = width;
      ctx.stroke();
      ctx.restore();
    }

    // Thin specular line down the middle, so the rope reads as round rather than flat.
    ctx.strokeStyle = held ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.22)';
    ctx.lineWidth = width * 0.28;
    ctx.stroke();
  }

  /**
   * The cursed rope: black casing with a red pulse breathing inside it.
   *
   * Assumes the caller has already built the path. It reads as an obstacle rather than a
   * rope you are meant to pick up, which is exactly what it is — grabbing it costs ten
   * moves, and anything crossing it costs double.
   */
  #cursedRope(rope, held, time, width) {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.0042);

    ctx.strokeStyle = '#000';
    ctx.lineWidth = width + 6;
    ctx.stroke();

    ctx.strokeStyle = '#0d0d11';
    ctx.lineWidth = width;
    ctx.stroke();

    ctx.save();
    // The glow carries most of the menace; the core alone is too thin to read.
    ctx.shadowColor = `rgba(255, 40, 30, ${(0.45 + pulse * 0.5).toFixed(3)})`;
    ctx.shadowBlur = 10 + pulse * 22 + (held ? 12 : 0);
    ctx.strokeStyle = `rgba(${Math.round(150 + pulse * 105)}, ${Math.round(14 + pulse * 26)}, 12, ${(0.75 + pulse * 0.25).toFixed(3)})`;
    ctx.lineWidth = width * (0.26 + pulse * 0.16);
    ctx.stroke();
    ctx.restore();
  }

  /** Expanding shockwave where the cursed rope was detonated by a full chain. */
  #explosions(explosions) {
    const { ctx } = this;
    ctx.save();

    for (const boom of explosions) {
      const t = 1 - boom.life / boom.total;
      const eased = 1 - (1 - t) * (1 - t);
      const radius = 18 + eased * 260;

      ctx.globalAlpha = clamp(1 - t, 0, 1) * 0.9;
      ctx.strokeStyle = '#ff4a2e';
      ctx.lineWidth = 10 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(boom.x, boom.y, radius, 0, Math.PI * 2);
      ctx.stroke();

      ctx.globalAlpha = clamp(1 - t, 0, 1) * 0.35;
      ctx.strokeStyle = '#ffd166';
      ctx.lineWidth = 4 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(boom.x, boom.y, radius * 0.62, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.restore();
  }

  /**
   * Chain callout. The countdown itself lives in the HUD bar under the move counter —
   * two competing timers would just split the player's attention — so this is purely the
   * "you are on a run" readout.
   */
  /**
   * The one combo indicator, directly under the decay bar.
   *
   * A knot count and the number it has accrued — the number knot scores fly up into. It
   * shows nothing below SHOW_FROM: one knot is an untangle, not a run.
   */
  #chain(state) {
    const { ctx } = this;
    const knots = state.chain || 0;
    if (knots < (state.comboShowFrom || 2)) return;

    const cursed = (state.cursedMult || 0) >= COMBO.CURSED_BASE;
    const time = state.time;
    const hot = knots >= 7;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (cursed) {
      // Frantic, and deliberately never periodic: two incommensurate sine terms per axis
      // so the jitter never settles into a rhythm the eye can tune out and stop reading.
      const shakeX = Math.sin(time * 0.058) * 3.6 + Math.sin(time * 0.131) * 2.1;
      const shakeY = Math.cos(time * 0.073) * 2.7 + Math.sin(time * 0.167) * 1.3;
      ctx.translate(this.width / 2 + shakeX, ORIGIN_Y + shakeY);

      // Huffing and puffing: a slow breath swelling and collapsing underneath the jitter,
      // an order of magnitude slower so it reads as strain rather than more noise.
      const breath = 1 + 0.1 * Math.sin(time * 0.0105) + 0.035 * Math.sin(time * 0.026);
      ctx.scale(breath, breath);
      ctx.rotate(Math.sin(time * 0.049) * 0.04);
    } else {
      ctx.translate(this.width / 2, ORIGIN_Y);
    }

    // The label: how many knots this run has taken, and what the curse is multiplying it
    // by if it is on.
    ctx.font = `800 15px ${DISPLAY}`;
    if (cursed) {
      ctx.fillStyle = '#ff4d3d';
      ctx.shadowColor = 'rgba(255, 77, 61, 0.75)';
      // The glow breathes out of phase with the scale, so the whole thing looks like it
      // is straining rather than simply zooming.
      ctx.shadowBlur = 16 + Math.sin(time * 0.0105 + 1.4) * 10;
    } else {
      ctx.fillStyle = hot ? '#ffd166' : '#9fb4d8';
      ctx.shadowColor = hot ? 'rgba(255,209,102,0.5)' : 'transparent';
      ctx.shadowBlur = hot ? 14 : 0;
    }
    this.#struck(state.cursedPop, 0, () =>
      ctx.fillText(cursed ? `CURSED COMBO ×${state.cursedMult}` : `${knots} KNOTS`, 0, 0),
    );

    // The total, and the thing knot scores fly up into. This is the number at stake, so it
    // is the biggest element in the indicator — and the one element the jump never touches,
    // because a flying knot score is aimed at where it is right now.
    ctx.font = `800 36px ${DISPLAY}`;
    ctx.fillStyle = cursed ? '#ff6a4d' : hot ? '#ffd166' : '#e8ecf4';
    ctx.shadowBlur = cursed ? 22 : hot ? 16 : 0;
    ctx.fillText(Math.round(state.comboValue || 0).toLocaleString(), 0, TOTAL_DY);

    // The ladder name for the cursed multiplier — the number in the label above. It sits
    // *under* the total rather than above it: the label slot is spent on the multiplier
    // itself, and the total has to stay exactly where it is, since that is the point knot
    // scores fly into. It jumps with the label, because it is the same fact said twice.
    if (cursed && state.comboName) {
      ctx.font = `700 13px ${DISPLAY}`;
      ctx.fillStyle = '#ffb4a6';
      ctx.shadowBlur = 12;
      this.#struck(state.cursedPop, NAME_DY, () => ctx.fillText(state.comboName, 0, NAME_DY));
    }

    ctx.restore();
  }

  /**
   * Draws `paint` mid-jump: a ballistic hop with a punch of scale on the way off the
   * ground, settling back to exactly where it started.
   *
   * `pop` runs 1 -> 0 over the life of the jump. The arc is `4t(1-t)`, which leaves the
   * ground at zero and lands at zero, so nothing is left displaced when it finishes — the
   * cursed readout is already shaking and breathing, and a jump that ended a pixel high
   * would accumulate into a drift over a long run.
   *
   * `baseY` is the line's own y, so both the hop and the scale happen about the text
   * rather than about the indicator's origin: scaling a line drawn at y=58 about the
   * origin would fling it down the screen instead of punching it in place.
   */
  #struck(pop, baseY, paint) {
    const { ctx } = this;
    if (!pop) {
      paint();
      return;
    }

    const t = 1 - pop;
    const hop = -CURSED_HOP_PX * 4 * t * (1 - t);
    // Damped overshoot, hardest on the first frames — the hit, rather than a smooth swell.
    const punch = 1 + 0.2 * Math.exp(-t * 11) * Math.cos(t * 26);

    ctx.save();
    ctx.translate(0, baseY + hop);
    ctx.scale(punch, punch);
    ctx.translate(0, -baseY);
    paint();
    ctx.restore();
  }

  #knotMarkers(points, time) {
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.005);
    const radius = 6 + pulse * 3.5;

    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(255, 122, 107, ${(0.45 + pulse * 0.4).toFixed(3)})`;
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /**
   * Floating "+points" popups, so a knot is felt where it happened.
   *
   * A knot taken during a live combo does not just rise and fade — it *travels* to the
   * combo total and lands in it, which is what makes the total read as something the
   * player is filling rather than a number that changes on its own.
   */
  #flashes(flashes) {
    const { ctx } = this;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = `700 17px ${DISPLAY}`;

    for (const flash of flashes) {
      const t = 1 - flash.life / flash.total;
      const alpha = flash.life > flash.total * 0.65 ? (1 - flash.life / flash.total) / 0.35 : flash.life / (flash.total * 0.65);
      ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
      ctx.fillStyle = flash.tone === 'deny' ? '#ff7a6b' : '#5ee6a8';

      if (flash.fly) {
        // Ease-in, so it drifts off the knot and then accelerates into the total rather
        // than sliding at a constant speed like a tooltip.
        const e = t * t * (3 - 2 * t) * t;
        ctx.fillText(
          flash.text,
          flash.x + (flash.toX - flash.x) * e,
          flash.y + (flash.toY - flash.y) * e,
        );
      } else {
        // A refusal sinks; an untangle with no run behind it just rises.
        ctx.fillText(flash.text, flash.x, flash.y + (flash.tone === 'deny' ? t * 18 : -t * 34));
      }
    }

    ctx.restore();
  }

  /**
   * Combo callout: several knots ripped apart by one pull deserves a shout.
   *
   * A *killed* combo — the same pull also parked the rope on another one — gets its own
   * death: it lands, shudders, bleeds from yellow into red, then drops out of frame. The
   * player still sees what they nearly had, which is the point of showing it at all.
   */
  #banner(banner) {
    const { ctx } = this;
    const t = 1 - banner.life / banner.total;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (banner.killed) {
      const shake = Math.max(0, 1 - t / 0.4);
      const fall = Math.max(0, (t - 0.4) / 0.6);

      ctx.globalAlpha = clamp(fall > 0.55 ? 1 - (fall - 0.55) / 0.45 : 1, 0, 1);
      ctx.translate(
        this.width / 2 + Math.sin(t * 118) * 12 * shake,
        // Quadratic drop, so it accelerates away like it fell rather than slid.
        BANNER_Y + fall * fall * this.height * 0.75,
      );
      ctx.rotate(Math.sin(t * 96) * 0.055 * shake + fall * 0.45);
    } else {
      const rise = Math.min(1, t * 5);
      // Overshoot then settle, so the callout punches in rather than easing in.
      const pop = 1 + 0.18 * Math.exp(-t * 14) * Math.cos(t * 34);
      ctx.globalAlpha = Math.max(0, t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1);
      ctx.translate(this.width / 2, BANNER_Y - rise * 14);
      ctx.scale(pop, pop);
    }

    let headline = '#ffd166';
    let subhead = '#ffe7ad';
    // A chain built on the curse pays out in the curse's colours, so the callout matches
    // the meter and the readout the player was watching the whole way up.
    if (banner.cursed && !banner.killed) {
      headline = '#ff6a4d';
      subhead = '#ffb4a6';
    }
    if (banner.killed) {
      // Gradient coordinates are in the already-translated space, so it travels with the
      // text instead of staying pinned to the viewport.
      const bleed = ctx.createLinearGradient(0, -50, 0, 26);
      bleed.addColorStop(0, '#ffd166');
      bleed.addColorStop(0.48, '#ff8a3d');
      bleed.addColorStop(1, '#d9291c');
      headline = bleed;
      subhead = bleed;
    }

    ctx.font = `800 20px ${DISPLAY}`;
    ctx.fillStyle = headline;
    ctx.shadowColor = banner.killed
      ? 'rgba(217, 41, 28, 0.5)'
      : banner.cursed
        ? 'rgba(255, 106, 77, 0.6)'
        : 'rgba(255, 209, 102, 0.55)';
    // Laid out to land on the live indicator it replaces: label where the label was, the
    // paid number where the running total was. The slot appears to resolve rather than
    // swap.
    ctx.shadowBlur = 22;
    // Only a cursed callout carries a name. Without one the headline drops onto the payout
    // rather than sitting up where it had to be to clear a middle line, so a normal combo
    // reads as two lines instead of two lines with a hole between them.
    ctx.fillText(banner.multiplier, 0, banner.text ? -24 : -14);

    if (banner.text) {
      ctx.font = `700 14px ${DISPLAY}`;
      ctx.fillStyle = subhead;
      ctx.shadowBlur = 12;
      ctx.fillText(banner.text, 0, -2);
    }

    if (banner.payout) {
      ctx.font = `800 32px ${DISPLAY}`;
      ctx.fillStyle = banner.killed ? '#d9291c' : '#5ee6a8';
      ctx.shadowColor = banner.killed ? 'rgba(217,41,28,0.5)' : 'rgba(94,230,168,0.45)';
      ctx.shadowBlur = 18;
      ctx.fillText(banner.payout, 0, 26);
    }

    ctx.restore();
  }

  #debug(state) {
    const { ctx } = this;
    const m = state.margin || 0;

    ctx.strokeStyle = 'rgba(94, 230, 168, 0.25)';
    ctx.lineWidth = 1;
    ctx.strokeRect(m, m, this.width - m * 2, this.height - m * 2);

    for (const rope of state.ropes) {
      if (rope.removed) continue;
      const b = rope.bounds;
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);

      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      for (const n of rope.nodes) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`#${rope.id}`, rope.nodes[0].x + 8, rope.nodes[0].y - 8);
    }

    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '12px ui-monospace, monospace';
    const lines = state.debugLines || [];
    lines.forEach((line, i) => ctx.fillText(line, 12, this.height - 12 - (lines.length - 1 - i) * 16));
  }
}
