import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { POOL } from '../src/config.js';
import { pooledTime, recordClear } from '../src/deadline.js';

/**
 * The shared pool of clear times.
 *
 * Deliberately a JSON file rather than a database. The whole store is one bounded ring of
 * numbers per stage — a few hundred kilobytes at the ceiling, with no relations, no
 * queries and no history worth keeping — and a dependency-free game is worth more than
 * anything a database would add to it.
 *
 * The statistics are not reimplemented here. Filing a time and building a par both come
 * from src/deadline.js, so the pool is aggregated by exactly the code the client models it
 * with. That matters most for the clamp inside recordClear: it is the only thing between
 * the pool and a forged submission, and a second copy of it that drifted would poison the
 * pool silently.
 */

const VERSION = 1;

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Whether a submission is worth showing the statistics at all.
 *
 * The trim and the clamp both need a populated pool to judge against, so neither can be
 * what defends an empty one — on the first submission for a stage there is nothing to be
 * an outlier from, and whatever arrives is taken as the truth. These bounds hold in that
 * case and every other.
 */
export function validSubmission(stage, ms) {
  if (!Number.isInteger(stage) || stage < 1 || stage > POOL.MAX_STAGE) return false;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return false;
  return ms >= POOL.MIN_MS && ms <= POOL.MAX_MS;
}

export class PoolStore {
  constructor(file) {
    this.file = file;
    /** stage -> ring of the most recent SERVER_KEEP times, newest last. */
    this.stages = Object.create(null);
    /** stage -> lifetime submissions, which outlives the ring and is only ever shown. */
    this.counts = Object.create(null);
    /** The last built par table, or null when a submission has invalidated it. */
    this.parsCache = null;
    this.dirty = false;
    this.flushTimer = null;
    /** The write in flight, or null. Every flush chains onto it — see flush(). */
    this.writing = null;
    /** ip -> { count, resetAt }. In memory only; a restart forgives everyone. */
    this.buckets = new Map();
  }

  /**
   * Reads the store, treating a missing or unreadable file as an empty pool.
   *
   * An empty pool is a completely valid state — it is what a freshly deployed server has —
   * so there is nothing here that should stop the server coming up. A corrupt file is the
   * one case worth being loud about, because starting fresh silently would discard a real
   * pool that a bad write left unparseable.
   */
  async load() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`[pool] ${this.file} unreadable (${err.message}) — starting empty`);
      }
      return this;
    }

    if (!isPlainObject(parsed) || !isPlainObject(parsed.stages)) return this;

    // The version is read rather than merely written, so the next schema change is a
    // decision here instead of a silent misreading of the old shape. A file with no `v`
    // predates nothing — v1 is the first — so it is treated as v1; a *newer* one comes
    // from a rolled-back deploy and cannot be understood, and the loud path is the only
    // honest one because the next flush will replace it. Migrations belong right here.
    const version = Number.isInteger(parsed.v) ? parsed.v : VERSION;
    if (version > VERSION) {
      console.warn(
        `[pool] ${this.file} is v${version}, this server understands v${VERSION} — ` +
          'starting empty, and the file WILL be overwritten. Back it up or upgrade.',
      );
      return this;
    }

    for (const [stage, samples] of Object.entries(parsed.stages)) {
      if (!/^\d+$/.test(stage) || !Array.isArray(samples)) continue;
      const clean = samples
        .filter((ms) => typeof ms === 'number' && Number.isFinite(ms) && ms > 0)
        .slice(-POOL.SERVER_KEEP);
      if (clean.length) this.stages[stage] = clean;
    }

    if (isPlainObject(parsed.counts)) {
      for (const [stage, n] of Object.entries(parsed.counts)) {
        if (/^\d+$/.test(stage) && Number.isInteger(n) && n >= 0) this.counts[stage] = n;
      }
    }

    return this;
  }

  /**
   * Files a time, or returns null if it was never plausible.
   *
   * The returned number is what was actually stored, which is not always what was sent —
   * recordClear pulls a submission back toward the stage's typical time before it lands.
   */
  submit(stage, ms) {
    if (!validSubmission(stage, ms)) return null;

    const stored = recordClear(this.stages, stage, ms, POOL.SERVER_KEEP);
    const key = String(stage);
    this.counts[key] = (this.counts[key] || 0) + 1;
    // The table this just invalidated is rebuilt on the next read, not here — a burst of
    // submissions should cost one rebuild between reads rather than one apiece.
    this.parsCache = null;
    this.#touch();
    return stored;
  }

  /**
   * The whole par table: stage -> { ms, n }.
   *
   * Cached, and invalidated by submit(). This used to be rebuilt per request on the
   * reasoning that a client asks for it about once a session — which is true of honest
   * clients and of nobody else. It sorts every sample of every stage, so at a full pool it
   * is about a millisecond of CPU on an unauthenticated GET, which is a hundred times what
   * serving a static file costs. Writes are far rarer than reads here, so paying on the
   * write is the right way round.
   */
  pars() {
    if (this.parsCache) return this.parsCache;

    const pars = {};
    for (const stage of Object.keys(this.stages)) {
      const ms = pooledTime(Number(stage), this.stages);
      if (ms === null) continue;
      pars[stage] = { ms: Math.round(ms), n: this.counts[stage] || this.stages[stage].length };
    }

    this.parsCache = pars;
    return pars;
  }

  /**
   * Whether this IP has submissions left in the current window.
   *
   * Not security — an IP is not an identity and anybody determined enough to forge times
   * can forge them from anywhere. This is here so that a stuck client in a retry loop
   * cannot bury the pool under one stage's worth of duplicates by accident.
   */
  allow(ip, now) {
    const bucket = this.buckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      this.buckets.set(ip, { count: 1, resetAt: now + POOL.RATE_WINDOW_MS });
      // Opportunistic sweep: without it the map holds every IP ever seen. Cheap because
      // it only runs on the request that opens a new window.
      if (this.buckets.size > 4096) {
        for (const [key, value] of this.buckets) if (now >= value.resetAt) this.buckets.delete(key);
      }
      return true;
    }
    if (bucket.count >= POOL.RATE_LIMIT) return false;
    bucket.count += 1;
    return true;
  }

  /** Batches writes: a busy server files many times per second, and the file is one blob. */
  #touch() {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((err) => console.error(`[pool] flush failed: ${err.message}`));
    }, 2000);
    this.flushTimer.unref?.();
  }

  /**
   * Writes anything outstanding, and resolves only once it is actually on disk.
   *
   * Every flush is chained onto the one before it rather than run concurrently. Two
   * overlapping flushes would race on the same temp path, and — more to the point — a
   * caller that started a write while another was in flight used to return immediately,
   * which is what let close() report success while the real write was still going and the
   * process was about to exit under it.
   */
  flush() {
    this.writing = (this.writing ?? Promise.resolve())
      // The previous write's failure is that caller's to report, not this one's. Swallowing
      // it here keeps a single bad write from poisoning every flush after it; the data it
      // failed to store is still marked dirty and goes out with this one.
      .catch(() => {})
      .then(() => (this.dirty ? this.#write() : undefined));
    return this.writing;
  }

  /**
   * One write, via a temporary file and a rename.
   *
   * The rename is the point. Writing in place means a crash or a full disk halfway through
   * leaves a truncated JSON file, which is the one input load() cannot recover a pool from;
   * a rename either happened or did not.
   *
   * `dirty` is cleared before the write and put back if it fails, which is the only
   * ordering that is safe in both directions: clearing it afterwards would drop a
   * submission that arrived mid-write, and leaving it set on failure is what makes the
   * next flush — or close() — retry rather than silently discard the pool. Serialising
   * the payload up front is what makes that safe: it is a snapshot, so a submission
   * landing during the await belongs to the next write and not to this one.
   */
  async #write() {
    const payload = JSON.stringify({ v: VERSION, stages: this.stages, counts: this.counts });
    this.dirty = false;

    try {
      const tmp = `${this.file}.${process.pid}.tmp`;
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(tmp, payload);
      await rename(tmp, this.file);
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }

  /** Stops the pending flush timer and writes anything outstanding. */
  async close() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }
}
