'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

// Defaults for a fresh database come from the site config (sites/<SITE>/site.config.json, default: demo).
const DEFAULT_SETTINGS = require('./site').toSettings(require('./site').load());

// add columns introduced after a database was first created (CREATE TABLE IF NOT EXISTS won't)
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const add = (t, c, def) => { const have = cols(t); if (have.length && !have.includes(c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`); };
  add('users', 'lowest_index', 'REAL'); add('users', 'achievements', 'TEXT'); add('users', 'subs_paid', 'INTEGER NOT NULL DEFAULT 0'); add('users', 'date_of_birth', 'TEXT'); add('team_events', 'src_hash', 'TEXT'); // 'MM-DD' or 'YYYY-MM-DD', admin-only year
  add('events', 'tournament_id', 'INTEGER'); add('events', 'round_no', 'INTEGER');
  add('events', 'end_date', 'TEXT'); // multi-day events: last day (NULL = one-day event)
  add('events', 'counts_birdie', 'INTEGER NOT NULL DEFAULT 1'); add('events', 'counts_fedex', 'INTEGER NOT NULL DEFAULT 1');
  add('ryder_cups', 'audio', 'TEXT'); add('ryder_cups', 'audio_label', 'TEXT'); // optional per-year voice clip
  add('results', 'hcp_played', 'REAL'); add('courses', 'holes', 'TEXT'); // JSON [{par,si}] x18 for hole-by-hole scoring // historical: the handicap a player actually played off (imported seasons)
}

/**
 * Open (and create/upgrade) the database. opts.site: a loaded site config whose feature-flag defaults
 * seed the feature switches of a fresh database; without it every module defaults to on (SOCIETY_FEATURES still applies).
 */
function open(dbPath, { site = null } = {}) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  const hadField = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='event_players'").get();
  const hadEvents = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='events'").get();
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  // first time with event_players on an existing database: everyone already in an event joins its field
  if (!hadField && hadEvents) require('./lib/field').backfill(db);
  require('./lib/scramble').ensureFromSite(db, site);
  require('./lib/site-setup').apply(db, site);
  const ins = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES (?,?)');
  for (const [k, v] of Object.entries({ ...DEFAULT_SETTINGS, ...require('./lib/features').defaults(site) })) ins.run(k, v);
  // a footer still showing the setup placeholder takes the site's real footer text (only if the site config has one)
  if (DEFAULT_SETTINGS.footer_blurb && !require('./site').isPlaceholderBlurb(DEFAULT_SETTINGS.footer_blurb))
    db.prepare("UPDATE settings SET value=? WHERE key='footer_blurb' AND value LIKE '%Rebrand me in Admin%'").run(DEFAULT_SETTINGS.footer_blurb);
  return db;
}

function getSettings(db) {
  const out = {};
  for (const r of db.prepare('SELECT key,value FROM settings').all()) out[r.key] = r.value;
  return out;
}
function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, String(value));
}

module.exports = { open, getSettings, setSetting, DEFAULT_SETTINGS };
