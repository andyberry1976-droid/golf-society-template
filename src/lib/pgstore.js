'use strict';
/**
 * Postgres persistence (Supabase or any Postgres) for the SQLite working copy.
 *
 * The app engine stays on better-sqlite3 (synchronous, fast, 350+ queries). When DATABASE_URL is set the
 * whole database (members, results, settings, feature switches, sessions …) is stored in Postgres:
 *   - on start the latest copy is loaded from Postgres (or, if Postgres is empty, the app seeds and saves);
 *   - after any change the database is saved back (debounced, ~1.5 s) and again on shutdown.
 * Each save keeps history (last KEEP versions) so a bad edit can be rolled back.
 * The connection string is never logged.
 */
const { Pool } = require('pg');

const KEEP = 30;
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS app_snapshots (
     id BIGSERIAL PRIMARY KEY,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     bytes INTEGER NOT NULL,
     reason TEXT,
     data BYTEA NOT NULL)`,
  'CREATE INDEX IF NOT EXISTS app_snapshots_created ON app_snapshots(created_at DESC)',
  `CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];

const redact = (s) => String(s || '').replace(/postgres(ql)?:\/\/[^\s'"]+/gi, '[db-url]');

function makePool(url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* */ }
  const local = /^(localhost|127\.0\.0\.1|::1|)$/.test(host) || /sslmode=disable/.test(url);
  return new Pool({
    connectionString: url.replace(/[?&]sslmode=[^&]*/g, ''),
    ssl: local ? false : { rejectUnauthorized: false }, // Supabase pooler: TLS required
    max: 2, connectionTimeoutMillis: 15000, idleTimeoutMillis: 30000,
  });
}

class PgStore {
  constructor(url) { this.pool = makePool(url); this.pool.on('error', (e) => console.error('pg pool error:', redact(e.message))); }
  async migrate() { for (const sql of MIGRATIONS) await this.pool.query(sql); }
  async load() {
    const r = await this.pool.query('SELECT data, created_at FROM app_snapshots ORDER BY id DESC LIMIT 1');
    return r.rows[0] ? { data: r.rows[0].data, at: r.rows[0].created_at } : null;
  }
  async save(buf, reason = 'change') {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO app_snapshots(bytes, reason, data) VALUES ($1,$2,$3)', [buf.length, reason, buf]);
      await c.query('DELETE FROM app_snapshots WHERE id NOT IN (SELECT id FROM app_snapshots ORDER BY id DESC LIMIT $1)', [KEEP]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }
  // ---- writer lease (see lib/handover.js) ----
  async metaGet(key) { const r = await this.pool.query('SELECT value FROM app_meta WHERE key=$1', [key]); return r.rows[0] ? JSON.parse(r.rows[0].value) : null; }
  async metaSet(key, v) { await this.pool.query('INSERT INTO app_meta(key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value', [key, JSON.stringify(v)]); }
  async claimWriter(me) { const prev = await this.metaGet('writer'); await this.metaSet('writer', { id: me, beat: Date.now() }); return prev; }
  getWriter() { return this.metaGet('writer'); }
  async beat(me) { await this.pool.query("UPDATE app_meta SET value=$2 WHERE key='writer' AND value::json->>'id'=$1", [me, JSON.stringify({ id: me, beat: Date.now() })]); }
  ack(me) { return this.metaSet('handover_ack', { from: me, at: Date.now() }); }
  getAck() { return this.metaGet('handover_ack'); }
  async list() { const r = await this.pool.query('SELECT id, created_at, bytes, reason FROM app_snapshots ORDER BY id DESC'); return r.rows; }
  async get(id) { const r = await this.pool.query('SELECT data, created_at FROM app_snapshots WHERE id=$1', [id]); return r.rows[0] || null; }
  async close() { await this.pool.end().catch(() => {}); }
}

/** Watch the SQLite db and push changes to Postgres. Returns { flush, stop }. */
function attachAutosave(db, store, { delayMs = 1500, log = console } = {}) {
  const changes = () => db.prepare('SELECT total_changes() n').get().n;
  let saved = changes(); let timer = null; let running = Promise.resolve(); let failures = 0; let halted = false;
  const flush = (reason = 'change') => {
    running = running.then(async () => {
      if (halted) return;
      const now = changes();
      if (now === saved && reason !== 'initial') return;
      try { await store.save(db.serialize(), reason); saved = now; failures = 0; } catch (e) {
        failures++; log.error(`Saving to Postgres failed (${failures}): ${redact(e.message)}`);
        if (failures < 5) schedule();
      }
    });
    return running;
  };
  const schedule = () => { if (timer) return; timer = setTimeout(() => { timer = null; flush(); }, delayMs); timer.unref && timer.unref(); };
  const poll = setInterval(() => { if (changes() !== saved) schedule(); }, 500); poll.unref();
  return {
    flush, check: () => { if (changes() !== saved) schedule(); },
    stop: async () => { clearInterval(poll); if (timer) clearTimeout(timer); timer = null; await flush('shutdown'); },
    // final save, then never save again (another instance owns the data now)
    halt: async (reason = 'handover') => { clearInterval(poll); if (timer) clearTimeout(timer); timer = null; await flush(reason); await running; halted = true; },
  };
}

module.exports = { PgStore, attachAutosave, redact, MIGRATIONS };
