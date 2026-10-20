'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { attachAutosave } = require('../src/lib/pgstore');
const H = require('../src/lib/handover');
const { miniSociety, startApp, Client } = require('./helpers');

/** In-memory stand-in for PgStore (same methods). */
function fakeStore() {
  const meta = new Map(); const snaps = [];
  return {
    snaps,
    async save(buf, reason) { snaps.push({ data: Buffer.from(buf), reason, at: new Date() }); },
    async load() { const s = snaps[snaps.length - 1]; return s ? { data: s.data, at: s.at } : null; },
    async claimWriter(me) { const p = meta.get('writer') || null; meta.set('writer', { id: me, beat: Date.now() }); return p; },
    async getWriter() { return meta.get('writer') || null; },
    async beat(me) { const w = meta.get('writer'); if (w && w.id === me) meta.set('writer', { id: me, beat: Date.now() }); },
    async ack(me) { meta.set('handover_ack', { from: me, at: Date.now() }); },
    async getAck() { return meta.get('handover_ack') || null; },
  };
}
const quiet = { log() {}, error() {} };
const count = (buf) => { const d = new Database(buf, { readonly: true }); const n = d.prepare('SELECT COUNT(*) n FROM award_types').get().n; d.close(); return n; };

test('deploy hand-over: edits made on the old instance up to the switch survive; later writes are refused', async () => {
  const store = fakeStore();
  const { db } = miniSociety();
  const app = await startApp(db);
  try {
    const autosave = attachAutosave(db, store, { delayMs: 60000, log: quiet }); // long debounce: a pending change must still be saved
    await autosave.flush('initial');
    assert.equal((await H.claim(store, 'A', { log: quiet })).prev, null);
    const lease = H.watch(store, 'A', { fence: app.app.locals.fence, autosave, pollMs: 20, log: quiet });
    const base = count(store.snaps.at(-1).data);

    // Admin adds an award on the old instance moments before the new instance boots (not yet saved: debounce)
    db.prepare("INSERT INTO award_types(name) VALUES ('Lost Ball of the Year')").run();

    // new instance boots: claims, waits for A to hand over, then loads
    const r = await H.claim(store, 'B', { log: quiet, pollMs: 10 });
    assert.equal(r.acked, true);
    assert.equal(lease.handed, true);
    assert.equal(count((await store.load()).data), base + 1, 'the award is in the snapshot B loads');

    // the old instance now refuses writes and never saves again
    const c = new Client(app.base);
    const tok = await c.csrf();
    const res = await c.req('POST', '/login', { form: { _csrf: tok, email: 'p1@t.example', password: 'password-123' } });
    assert.equal(res.status, 503);
    const n = store.snaps.length;
    db.prepare("INSERT INTO award_types(name) VALUES ('Too late')").run();
    await autosave.flush('change');
    assert.equal(store.snaps.length, n, 'old instance does not overwrite the new one');
  } finally { await app.close(); }
});

test('hand-over: a stale previous writer is not waited for; shutdown releases and acks', async () => {
  const store = fakeStore();
  await store.claimWriter('old'); (await store.getWriter()).beat = Date.now() - H.STALE_MS - 1;
  const t0 = Date.now(); const r = await H.claim(store, 'A', { log: quiet });
  assert.equal(r.stale, true); assert.ok(Date.now() - t0 < 500);
  const fence = H.makeFence();
  const lease = H.watch(store, 'A', { fence, autosave: { halt: async () => {} }, pollMs: 1000, log: quiet });
  await lease.release();
  assert.equal(fence.readOnly, true); assert.equal((await store.getAck()).from, 'A');
  const r2 = await H.claim(store, 'B', { log: quiet, pollMs: 10 });
  assert.equal(r2.acked, true);
});

test('award icons: preset SVG or an admin-chosen emoji (escaped)', () => {
  const h = require('../src/lib/view-helpers');
  assert.match(h.iconHtml('s-trophy'), /<use href="#s-trophy"\/>/);
  assert.match(h.iconHtml('🐌'), /<span class="emo"[^>]*>🐌<\/span>/);
  assert.doesNotMatch(h.iconHtml('<b>x'), /<b>/);
});
