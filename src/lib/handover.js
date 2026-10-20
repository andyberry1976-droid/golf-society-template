'use strict';
/**
 * Safe hand-over between app instances that share one Postgres copy of the database.
 *
 * On a deploy (or restart) the host starts the NEW instance while the OLD one is still serving. Without
 * care the new one loads the latest snapshot at boot, and anything saved by the old instance after that
 * moment is silently lost when traffic switches. The hand-over closes that gap:
 *   1. the new instance claims the "writer" lease in Postgres (app_meta) BEFORE loading anything;
 *   2. the old instance notices within ~1 s (or on SIGTERM): it refuses new writes (503 "updating, try
 *      again"), waits for in-flight writes to finish, saves a final snapshot, stops saving, and acks;
 *   3. the new instance waits for that ack (or for the old lease to go stale) and only then loads the
 *      latest snapshot and starts serving.
 * The old instance never saves again after acking, so it cannot overwrite the new instance's data.
 */
const crypto = require('crypto');

const STALE_MS = 10000; // a writer whose heartbeat is older than this is gone

/** Shared per-app write fence: middleware blocks writes once readOnly, and counts in-flight writes. */
function makeFence() { return { readOnly: false, inflight: 0 }; }

function fenceMiddleware(fence) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (fence.readOnly) {
      res.set('Retry-After', '5');
      return res.status(503).type('html').send('<!doctype html><meta charset="utf-8"><title>Updating</title><body style="font-family:system-ui;padding:40px;max-width:560px;margin:auto"><h1>The site is updating</h1><p>Nothing was saved. Please go back and try again in a few seconds.</p></body>');
    }
    fence.inflight++;
    let done = false; const end = () => { if (!done) { done = true; fence.inflight--; } };
    res.on('finish', end); res.on('close', end);
    return next();
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** New instance: claim the lease, wait for the previous writer to hand over, then return. */
async function claim(store, me, { waitMs = 15000, pollMs = 300, log = console } = {}) {
  const prev = await store.claimWriter(me);
  if (!prev || prev.id === me) return { waited: 0, prev: null };
  if (Date.now() - prev.beat > STALE_MS) { log.log(`Hand-over: previous instance ${prev.id} is gone (no heartbeat); loading the latest data.`); return { waited: 0, prev: prev.id, stale: true }; }
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    const ack = await store.getAck();
    if (ack && ack.from === prev.id) { log.log(`Hand-over: ${prev.id} saved its last changes and stopped writing (${Date.now() - t0} ms).`); return { waited: Date.now() - t0, prev: prev.id, acked: true }; }
    await sleep(pollMs);
  }
  log.error(`Hand-over: no ack from ${prev.id} after ${waitMs} ms; loading the latest data anyway.`);
  return { waited: Date.now() - t0, prev: prev.id, timedOut: true };
}

/**
 * Running instance: heartbeat the lease; when another instance takes it (or on release()), stop writes,
 * flush and ack. Returns { release, stop }.
 */
function watch(store, me, { fence, autosave, pollMs = 1000, log = console } = {}) {
  let handed = false; let timer = null;
  const handOver = async (why) => {
    if (handed) return; handed = true;
    clearInterval(timer);
    fence.readOnly = true;
    const t0 = Date.now();
    while (fence.inflight > 0 && Date.now() - t0 < 5000) await sleep(25);
    try { if (autosave) await autosave.halt(why); } catch (e) { log.error(`Hand-over: final save failed: ${e.message}`); }
    try { await store.ack(me); } catch (e) { log.error(`Hand-over: ack failed: ${e.message}`); }
    log.log(`Hand-over (${why}): writes stopped, last changes saved.`);
  };
  const tick = async () => {
    if (handed) return;
    try {
      const w = await store.getWriter();
      if (w && w.id !== me) return handOver(`instance ${w.id} took over`);
      await store.beat(me);
    } catch (e) { log.error(`Hand-over: lease check failed: ${e.message}`); }
  };
  timer = setInterval(tick, pollMs); timer.unref && timer.unref();
  return { release: () => handOver('shutdown'), tick, get handed() { return handed; } };
}

const newId = () => (process.env.RENDER_INSTANCE_ID || 'i') + '-' + crypto.randomBytes(3).toString('hex');

module.exports = { makeFence, fenceMiddleware, claim, watch, newId, STALE_MS };
