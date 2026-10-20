#!/usr/bin/env node
'use strict';
/**
 * Consistent online backup of the SQLite database (safe while the app is running).
 *   npm run backup                 -> backups/society-YYYYMMDD-HHMMSS.db   (keeps the newest 14)
 *   node scripts/backup.js out.db  -> writes to a path you choose
 * Restore: stop the app, copy a backup over DATABASE_PATH (delete the -wal/-shm files), start the app.
 */
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { load } = require('../src/config');

(async () => {
  const config = load(process.env);
  if (!fs.existsSync(config.dbPath)) { console.error('No database at ' + config.dbPath); process.exit(1); }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = process.argv[2] || path.join(path.dirname(config.dbPath), '..', 'backups', `society-${stamp}.db`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const db = new Database(config.dbPath, { readonly: true });
  await db.backup(dest);
  db.close();
  console.log('Backup written to ' + path.resolve(dest));
  if (!process.argv[2]) {
    const dir = path.dirname(dest);
    const keep = fs.readdirSync(dir).filter((f) => /^society-.*\.db$/.test(f)).sort().reverse();
    for (const old of keep.slice(14)) fs.unlinkSync(path.join(dir, old));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
