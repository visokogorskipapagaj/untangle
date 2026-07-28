import { ROPE } from './config.js';
import { clamp } from './geometry.js';

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

    this.#background();

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

    if (state.showMarkers && state.crossings.length) {
      this.#crossings(state.crossings, state.time);
    }

    if (state.explosions && state.explosions.length) this.#explosions(state.explosions);
    if (state.chain > 1) this.#chain(state.chain, state.chainPot || 0, state.comboMax || 10);
    if (state.flashes && state.flashes.length) this.#flashes(state.flashes);
    if (state.banner) this.#banner(state.banner);

    if (state.debug) this.#debug(state);

    ctx.restore();
  }

  #background() {
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
  #chain(rawChain, pot, max) {
    const { ctx } = this;
    // A heavy rope can vault the chain past the cap; show what actually pays.
    const chain = Math.min(rawChain, max);
    const hot = chain >= 7;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.translate(this.width / 2, 108);

    ctx.font = '800 22px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = hot ? '#ffd166' : '#9fb4d8';
    ctx.shadowColor = hot ? 'rgba(255,209,102,0.5)' : 'transparent';
    ctx.shadowBlur = hot ? 16 : 0;
    ctx.fillText(`CHAIN ×${chain}`, 0, 0);

    // What the run is holding, and what it becomes if landed at this rung. The whole
    // point of escrowing points is that the player can see the stake growing.
    if (pot > 0) {
      ctx.shadowBlur = 0;
      ctx.font = '600 13px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = 'rgba(232, 236, 244, 0.62)';
      ctx.fillText(
        `${Math.round(pot).toLocaleString()} × ${chain} = ${Math.round(pot * chain).toLocaleString()}`,
        0,
        22,
      );
    }

    ctx.restore();
  }

  #crossings(points, time) {
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

  /** Floating "+points" popups, so a good untangle is felt where it happened. */
  #flashes(flashes) {
    const { ctx } = this;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.font = '600 17px ui-monospace, SFMono-Regular, Menlo, monospace';

    for (const flash of flashes) {
      const t = 1 - flash.life / flash.total;
      const alpha = flash.life > flash.total * 0.65 ? (1 - flash.life / flash.total) / 0.35 : flash.life / (flash.total * 0.65);
      ctx.globalAlpha = Math.min(1, Math.max(0, alpha));
      ctx.fillStyle = flash.tone === 'deny' ? '#ff7a6b' : '#5ee6a8';
      // A refusal sinks; an award rises.
      ctx.fillText(flash.text, flash.x, flash.y + (flash.tone === 'deny' ? t * 18 : -t * 34));
    }

    ctx.restore();
  }

  /**
   * Combo callout: several crossings ripped apart by one pull deserves a shout.
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
        this.height * 0.34 + fall * fall * this.height * 0.75,
      );
      ctx.rotate(Math.sin(t * 96) * 0.055 * shake + fall * 0.45);
    } else {
      const rise = Math.min(1, t * 5);
      // Overshoot then settle, so the callout punches in rather than easing in.
      const pop = 1 + 0.18 * Math.exp(-t * 14) * Math.cos(t * 34);
      ctx.globalAlpha = Math.max(0, t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1);
      ctx.translate(this.width / 2, this.height * 0.34 - rise * 18);
      ctx.scale(pop, pop);
    }

    let headline = '#ffd166';
    let subhead = '#ffe7ad';
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

    ctx.font = '800 46px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.fillStyle = headline;
    ctx.shadowColor = banner.killed ? 'rgba(217, 41, 28, 0.5)' : 'rgba(255, 209, 102, 0.55)';
    ctx.shadowBlur = 26;
    ctx.fillText(banner.multiplier, 0, -26);

    ctx.font = '700 20px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = subhead;
    ctx.shadowBlur = 14;
    ctx.fillText(banner.text, 0, 14);

    if (banner.payout) {
      ctx.font = '700 26px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillStyle = banner.killed ? '#d9291c' : '#5ee6a8';
      ctx.shadowColor = banner.killed ? 'rgba(217,41,28,0.5)' : 'rgba(94,230,168,0.45)';
      ctx.shadowBlur = 18;
      ctx.fillText(banner.payout, 0, 46);
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
