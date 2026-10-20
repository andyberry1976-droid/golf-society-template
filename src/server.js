'use strict';
const fs = require('fs');
const path = require('path');
// tiny .env loader (no dependency): KEY=VALUE lines, does not override real env vars
try {
  const envFile = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
} catch { /* ignore */ }

const { load } = require('./config');
const { open, setSetting } = require('./db');
const { createApp } = require('./app');
const users = require('./lib/users');
const { recomputeAll } = require('./lib/engine');
const { seedBase } = require('./lib/baseline');

function ensureAdmin(db, config) {
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (count === 0 && config.adminEmail) {
    if (config.production && (config.adminPassword.length < 10 || config.adminPassword === config.demoPassword)) {
      throw new Error('ADMIN_PASSWORD must be set (min 10 chars, and not the demo password) to create the first admin in production.');
    }
    const pw = config.adminPassword || require('crypto').randomBytes(9).toString('base64url'); // dev: one-time random, never a shared demo password
    users.createUser(db, { name: config.adminName, email: config.adminEmail, passwordHash: users.hashPassword(pw), role: 'admin', index: null });
    if (process.env.SOCIETY_NAME) setSetting(db, 'society_name', config.societyName);
    console.log(`Created first admin ${config.adminEmail}${config.adminPassword ? '' : ` with one-time dev password ${pw} (set ADMIN_PASSWORD to choose your own)`}`);
  }
  if (config.production) {
    // Refuse to run in production while any admin/captain still uses the documented demo password.
    for (const u of db.prepare("SELECT email, password_hash FROM users WHERE role IN ('admin','captain') AND password_hash IS NOT NULL").all()) {
      if (users.checkPassword(config.demoPassword, u.password_hash)) {
        throw new Error(`Refusing to start in production: ${u.email} still uses the DEMO password. Change it (log in as them and use My account, or reset via Admin → Members), then restart.`);
      }
    }
  }
}

function seedIfEmpty(db, config) {
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (n > 0 || process.env.AUTO_SEED === 'off') return false;
  if (config.production && process.env.SEED_DEMO !== 'true') return false; // production: first admin from ADMIN_EMAIL instead
  const site = require('./site').load();
  const out = require('./seed').seedSite(db, site);
  if (!out) return false;
  console.log(`Empty database: seeded ${site.name} (${out.people} members, ${out.events} events).`);
  return true;
}

async function start() {
  const config = load();
  const url = process.env.DATABASE_URL || '';
  let store = null;
  const me = require('./lib/handover').newId();
  let db;
  let snap = null;
  if (url) {
    const { PgStore } = require('./lib/pgstore');
    store = new PgStore(url);
    try {
      await store.migrate();
      // claim the writer lease and let the previous instance save its last changes BEFORE loading
      await require('./lib/handover').claim(store, me);
      snap = await store.load();
    } catch (e) {
      console.error(`!! Could not reach Postgres (${require('./lib/pgstore').redact(e.message)}). Starting on local SQLite WITHOUT persistence.`);
      await store.close(); store = null;
    }
  }
  if (store) {
    const snapData = snap;
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
    if (snapData) {
      fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
      fs.writeFileSync(config.dbPath, snapData.data);
      console.log(`Loaded data from Postgres (saved ${new Date(snapData.at).toISOString()}, ${snapData.data.length} bytes).`);
    } else console.log('Postgres is empty: creating the database.');
    db = open(config.dbPath, { site: require('./site').load() });
  } else {
    if (!url) console.log('DATABASE_URL not set: using local SQLite only (data is lost when the host wipes its disk).');
    db = open(config.dbPath, { site: require('./site').load() });
  }
  seedIfEmpty(db, config);
  ensureAdmin(db, config);
  seedBase(db);
  // a site config can lock the handicap module (the Demo: fixed, admin-set handicaps)
  const siteCfg = require('./site').load();
  const hc = (siteCfg.rules && siteCfg.rules.handicap) || {};
  if (hc.locked && hc.module) {
    const r = require('./lib/hcp-mode').setHandicapMode(db, hc.module, { reason: 'locked by site config' });
    if (r.changed) console.log(`Handicap module set to "${hc.module}" (locked by site config)${r.frozen ? `; ${r.frozen} earlier automatic adjustments kept as manual entries` : ''}.`);
  }
  recomputeAll(db);
  let autosave = null;
  if (store) {
    const { attachAutosave } = require('./lib/pgstore');
    autosave = attachAutosave(db, store);
    await autosave.flush('initial');
    console.log('Postgres persistence on: changes are saved automatically.');
  }
  const app = createApp({ db, config });
  app.locals.store = store;
  const lease = store ? require('./lib/handover').watch(store, me, { fence: app.locals.fence, autosave }) : null;
  const server = app.listen(config.port, () => console.log(`Society app listening on http://localhost:${config.port} (${config.production ? 'production' : 'development'})`));
  let closing = false;
  const shutdown = async () => {
    if (closing) return; closing = true;
    setTimeout(() => process.exit(0), 9000).unref();
    server.close();
    try { if (lease) await lease.release(); else if (autosave) await autosave.stop(); if (store) await store.close(); } catch (e) { console.error(String(e.message)); }
    try { db.close(); } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return { app, server, db, store, autosave, lease };
}

if (require.main === module) {
  start().catch((e) => { console.error(require('./lib/pgstore').redact(e.message)); process.exit(1); });
}
module.exports = { start, ensureAdmin, seedIfEmpty };
