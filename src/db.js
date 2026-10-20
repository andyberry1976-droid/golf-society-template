'use strict';
const fs = require('fs'); const path = require('path'); const Database = require('better-sqlite3');
const DEFAULTS = { name: 'Your Golf Society', tagline: 'Fixtures, results and leagues', primary: '#0a6b4b', accent: '#e8b100', logo_url: '' };
function open(file = ':memory:') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file); db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const ins = db.prepare('INSERT OR IGNORE INTO settings(society_id,key,value) VALUES (1,?,?)');
  for (const [k, v] of Object.entries(DEFAULTS)) ins.run(k, v);
  return db;
}
const settings = (db) => Object.fromEntries(db.prepare('SELECT key,value FROM settings WHERE society_id=1').all().map((r) => [r.key, r.value]));
const setSetting = (db, k, v) => db.prepare('INSERT INTO settings(society_id,key,value) VALUES (1,?,?) ON CONFLICT(society_id,key) DO UPDATE SET value=excluded.value').run(k, String(v));
module.exports = { open, settings, setSetting, DEFAULTS };
