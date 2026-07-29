import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { POOL } from '../src/config.js';
import { PoolStore } from './store.js';

/**
 * The game, and the pool behind it, off one dependency-free Node server.
 *
 * Static files are served from here as well as the API so that `npm start` is still one
 * command and the API is still same-origin — POOL.BASE_URL exists for the deployment that
 * splits them, and the CORS headers below are what make that deployment work.
 */

const ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));
const DATA_FILE = process.env.UNTANGLE_DATA || join(ROOT, 'server', 'data', 'pool.json');
const PORT = Number(process.env.PORT) || 8000;

/**
 * The built game. `npm run build` writes it and `npm start` runs that first, so the only way
 * to arrive here without one is `npm run serve` on a clean checkout — which start() says so
 * about rather than serving 404s and letting somebody work out why the page is blank.
 */
const PUBLIC_DIR = resolve(process.env.UNTANGLE_PUBLIC || join(ROOT, 'dist'));

/**
 * Only what the game actually serves. An unknown extension is served as a download rather
 * than guessed at, because guessing is how a static server ends up serving something as
 * text/html that should not be.
 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  // The build emits source maps beside the bundle, and a map served as a download is a
  // devtools panel that silently shows minified output instead of the component sources.
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/**
 * Largest POST body buffered, derived rather than picked.
 *
 * A full outbox is POOL.OUTBOX_MAX entries of `{"stage":123,"ms":123456}`, which a flat
 * kilobyte does not fit — and the client that would hit it is one that has been offline
 * for a while and has the most to contribute. Sixty-four bytes an entry is roughly double
 * the real width, so the limit stays well clear of any honest client.
 */
const MAX_BODY = POOL.OUTBOX_MAX * 64 + 256;

/** Thrown by readBody so the handler can answer 413 rather than a generic 400. */
class BodyTooLarge extends Error {}

function json(res, status, body, cacheControl = 'no-store') {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The pool is public data and the game may be served from anywhere.
    'access-control-allow-origin': '*',
    'cache-control': cacheControl,
  });
  res.end(payload);
}

/**
 * The client's address, trusting X-Forwarded-For only when told to.
 *
 * Behind a proxy the socket address is the proxy's and every player shares one rate limit;
 * in front of one, an attacker sets X-Forwarded-For to whatever they like and has none. It
 * cannot be both, and there is no way to detect which — so it is a deliberate switch, off.
 */
function clientIp(req) {
  if (process.env.UNTANGLE_TRUST_PROXY === '1') {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Buffers a request body, up to MAX_BODY.
 *
 * An oversized body is drained rather than the socket destroyed. Destroying it means the
 * client gets a connection reset instead of the status explaining what it did wrong, and
 * an honest client retrying forever against a reset is exactly the loop the rate limit
 * exists to stop. Nothing is buffered past the limit, so draining costs memory nothing.
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let over = false;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        over = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () =>
      over ? reject(new BodyTooLarge()) : resolve(Buffer.concat(chunks).toString('utf8')),
    );
    req.on('error', reject);
  });
}

/**
 * Resolves a URL path to a servable file under PUBLIC_DIR, or null.
 *
 * This used to be an allowlist of two filenames and the `src` directory, because the game
 * was served straight out of the git checkout and "anything under ROOT" would have handed
 * out .git, package.json, the tests and this server's own source alongside it. There is a
 * build now, and `dist` contains the built game and nothing else — so the rule can finally
 * be the obvious one, and the checkout is out of reach because it is not in the tree being
 * served at all.
 *
 * Resolve first, then verify: `..` segments and encodings are collapsed by resolve() and the
 * result is checked for where it actually landed, rather than the path being inspected for
 * things that look like an escape. Note that `new URL()` normalises `/../package.json` to
 * `/package.json` before anything here sees it — which now lands on `dist/package.json` and
 * is simply not there.
 */
function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const relative = normalize(decoded).replace(/^([/\\]|\.\.[/\\])+/, '');
  const full = resolve(join(PUBLIC_DIR, relative === '' ? 'index.html' : relative));
  if (full !== PUBLIC_DIR && !full.startsWith(PUBLIC_DIR + sep)) return null;
  return full;
}

/**
 * How long the client may keep a file.
 *
 * Everything the build emits under `assets/` carries a content hash in its name, so a change
 * is a new URL and the old one can never be stale — which is the one case where a year is
 * the correct answer. index.html is the opposite: it is the thing that names those hashes,
 * so caching it is how a browser pins itself to the previous release forever.
 */
function cacheFor(pathname) {
  return pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
}

async function serveStatic(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const full = resolveStatic(pathname);
  if (!full) return json(res, 403, { error: 'forbidden' });

  let info;
  try {
    info = await stat(full);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
  if (info.isDirectory()) return json(res, 404, { error: 'not found' });

  res.writeHead(200, {
    'content-type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
    'content-length': info.size,
    'cache-control': cacheFor(pathname),
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(full).pipe(res);
}

export function createApp(store) {
  return async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://localhost');

    if (pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': 'content-type',
          'access-control-max-age': '86400',
        });
        return res.end();
      }

      // Reads and writes share one budget. The read used to be the unmetered one, which
      // had it backwards: it is the expensive endpoint, and the only one an anonymous
      // caller can reach without having anything to say.
      if (!store.allow(clientIp(req), Date.now())) {
        return json(res, 429, { error: 'slow down' });
      }

      if (pathname === '/api/pars' && req.method === 'GET') {
        // Publicly cacheable: an aggregate over hundreds of runs does not move between one
        // request and the next, so a proxy answering for us is a proxy doing its job.
        return json(res, 200, { pars: store.pars() }, `public, max-age=${POOL.PARS_MAX_AGE_S}`);
      }

      if (pathname === '/api/times' && req.method === 'POST') {

        let body;
        try {
          body = JSON.parse(await readBody(req));
        } catch (err) {
          if (err instanceof BodyTooLarge) return json(res, 413, { error: 'too large' });
          return json(res, 400, { error: 'bad request' });
        }

        // One shape, and a batch of the same shape, because the client's offline outbox
        // arrives as a batch and a round trip per stranded time would be silly.
        const times = Array.isArray(body?.times) ? body.times : [body];
        if (times.length > POOL.OUTBOX_MAX) return json(res, 400, { error: 'too many' });

        // A rejected time is not an error the client can do anything about — it retried
        // correctly and the server judged the number — so the response counts rather than
        // fails, and the client clears its outbox either way.
        let stored = 0;
        for (const entry of times) {
          if (store.submit(entry?.stage, entry?.ms) !== null) stored += 1;
        }
        return json(res, 200, { stored, received: times.length });
      }

      return json(res, 404, { error: 'not found' });
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' });
    }
    return serveStatic(req, res);
  };
}

export async function start(port = PORT, file = DATA_FILE) {
  const store = await new PoolStore(file).load();

  // Said once, at startup, rather than as a blank page and a handful of 404s. `npm start`
  // builds first, so the only way here is `npm run serve` before anything has been built.
  try {
    await stat(join(PUBLIC_DIR, 'index.html'));
  } catch {
    console.warn(`[pool] no build at ${PUBLIC_DIR} — run \`npm run build\` (or \`npm start\`)`);
  }

  const server = createServer((req, res) => {
    createApp(store)(req, res).catch((err) => {
      console.error(`[pool] ${req.method} ${req.url}: ${err.message}`);
      if (!res.headersSent) json(res, 500, { error: 'server error' });
      else res.end();
    });
  });

  // The debounced flush means up to two seconds of times live only in memory. Shutdown is
  // the one moment that is knowable, so it is the one moment worth waiting for the disk.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      server.close();
      store.close().finally(() => process.exit(0));
    });
  }

  await new Promise((ready) => server.listen(port, ready));
  const stages = Object.keys(store.stages).length;
  console.log(`[pool] http://localhost:${port} — ${stages} stage(s) pooled from ${file}`);
  return { server, store };
}

// Only when run directly, so the tests can import createApp without binding a port.
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  start();
}
