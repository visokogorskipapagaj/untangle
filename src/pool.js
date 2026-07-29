import { POOL } from './config.js';

/**
 * The client's half of the shared pool.
 *
 * The whole design is in one constraint: loadStage is synchronous, and is called from six
 * places across the stage lifecycle. Awaiting a par inside it would make every one of them
 * async for a number that changes about as fast as a playerbase does. So nothing here is
 * ever awaited by the game — `pars` is a plain object, readable on any frame, hydrated from
 * localStorage before the first board is built and refreshed from the server whenever the
 * answer arrives. A stage loaded in the second before it lands uses the cached table, or
 * the player's own history, and neither is wrong.
 *
 * Every failure mode is the same failure mode: no network, no server, a 500, a hostile
 * captive portal. All of them leave `pars` exactly as it was, and the game keeps working
 * off the device's own times the way it did before there was a pool at all.
 */

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** localStorage, or null where it is unavailable — private mode, or a headless harness. */
function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readJson(key) {
  try {
    const raw = storage()?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  try {
    storage()?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or private mode. The cache is an optimisation and the outbox is a courtesy.
  }
}

/**
 * Reduces the server's table to what the deadline model reads: stage -> ms.
 *
 * Everything is re-checked rather than trusted. This is parsed from a network response and
 * from localStorage, and a string where a number belongs would reach stageDeadline and
 * produce a NaN deadline — a clock that is neither running nor off.
 */
function toPars(raw) {
  const pars = {};
  if (!isPlainObject(raw)) return pars;
  for (const [stage, entry] of Object.entries(raw)) {
    if (!/^\d+$/.test(stage)) continue;
    const ms = isPlainObject(entry) ? entry.ms : entry;
    if (typeof ms === 'number' && Number.isFinite(ms) && ms > 0) pars[stage] = ms;
  }
  return pars;
}

async function request(url, options = {}) {
  // AbortSignal.timeout is the reason this needs no manual timer. A request left hanging
  // on a captive portal would otherwise keep the outbox from ever draining.
  const signal = AbortSignal.timeout?.(POOL.TIMEOUT_MS);
  const response = await fetch(url, { ...options, signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

export class Pool {
  constructor({ baseUrl = POOL.BASE_URL, now = () => Date.now() } = {}) {
    this.baseUrl = baseUrl;
    this.now = now;

    /**
     * stage -> expected ms. Handed straight to stageDeadline, and the only thing the game
     * reads off this object. Replaced wholesale on refresh rather than merged, so a stage
     * the server has dropped stops being pooled here too.
     */
    this.pars = {};
    this.fetchedAt = 0;
    /** Times recorded while the server was unreachable, oldest first. */
    this.outbox = readJson(POOL.OUTBOX_KEY) ?? [];
    if (!Array.isArray(this.outbox)) this.outbox = [];
    /** One drain at a time, so a submit mid-flight cannot send the same batch twice. */
    this.draining = false;

    const cached = readJson(POOL.CACHE_KEY);
    if (isPlainObject(cached)) {
      this.pars = toPars(cached.pars);
      this.fetchedAt = Number(cached.at) || 0;
    }
  }

  /** Whether the cached table is old enough to be worth a request. */
  get stale() {
    return this.now() - this.fetchedAt > POOL.MAX_AGE_MS;
  }

  /**
   * Brings the table up to date and drains the outbox, and never throws.
   *
   * Called once at boot without being awaited. The refresh is skipped on a fresh cache but
   * the drain is not: an outbox with anything in it is a previous session that could not
   * reach the server, and this is the first moment it might be able to.
   */
  async sync() {
    if (this.outbox.length) await this.#drain();
    if (!this.stale) return this.pars;

    try {
      const body = await request(`${this.baseUrl}/api/pars`);
      this.pars = toPars(body?.pars);
      this.fetchedAt = this.now();
      writeJson(POOL.CACHE_KEY, { at: this.fetchedAt, pars: this.pars });
    } catch {
      // Keep whatever is cached. A stale table is a better deadline than no deadline, and
      // no deadline is what the game falls back to anyway.
    }
    return this.pars;
  }

  /**
   * Contributes a clear time, and keeps it if that fails.
   *
   * Fire-and-forget by design: the game calls this in the middle of scoring a solved stage
   * and must not wait on it. The par this time affects is the next player's, or this
   * player's next session — never the run in progress — so there is nothing to await.
   */
  submit(stage, ms) {
    this.outbox.push({ stage, ms: Math.round(ms) });
    // Oldest out first. A long offline run contributes its last few clears rather than
    // growing the outbox without limit; the pool loses nothing it would have noticed.
    if (this.outbox.length > POOL.OUTBOX_MAX) {
      this.outbox.splice(0, this.outbox.length - POOL.OUTBOX_MAX);
    }
    writeJson(POOL.OUTBOX_KEY, this.outbox);
    this.#drain().catch(() => {});
  }

  /**
   * Sends everything held and clears it on success.
   *
   * The batch is captured before the request so that a clear landing mid-flight is not
   * dropped by the splice below — it stays in the outbox and goes with the next one.
   */
  async #drain() {
    if (this.draining || !this.outbox.length) return;
    this.draining = true;
    const batch = this.outbox.slice(0, POOL.OUTBOX_MAX);

    try {
      await request(`${this.baseUrl}/api/times`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ times: batch }),
      });
      // Cleared on a 2xx whatever the server made of the contents. A time it judged
      // implausible is not one this client can improve by sending it again.
      //
      // Removed by identity rather than by count: a clear landing mid-flight pushes onto
      // the outbox, and on a full one that also drops an entry off the front, so a
      // splice(0, batch.length) here would take one more than it sent.
      const sent = new Set(batch);
      this.outbox = this.outbox.filter((entry) => !sent.has(entry));
      writeJson(POOL.OUTBOX_KEY, this.outbox);
    } catch {
      // Held for the next submit or the next boot.
    } finally {
      this.draining = false;
    }
  }
}
