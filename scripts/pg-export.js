'use strict';
// Write the latest app database stored in Postgres to a SQLite file.
//   DATABASE_URL=… node scripts/pg-export.js backup.db
// Restore a .db into Postgres (becomes the newest copy; restart the app afterwards):
//   DATABASE_URL=… node scripts/pg-export.js --import backup.db
const fs = require('fs');
const { PgStore, redact } = require('../src/lib/pgstore');
(async () => {
  const url = process.env.DATABASE_URL; if (!url) throw new Error('Set DATABASE_URL');
  const store = new PgStore(url); await store.migrate();
  const args = process.argv.slice(2);
  if (args[0] === '--import') {
    const buf = fs.readFileSync(args[1]);
    if (buf.subarray(0, 15).toString() !== 'SQLite format 3') throw new Error('Not a SQLite file');
    await store.save(buf, 'import'); console.log(`Imported ${args[1]} (${buf.length} bytes). Restart the app to load it.`);
  } else {
    const snap = await store.load(); if (!snap) throw new Error('Postgres has no saved data yet');
    const out = args[0] || `demo-${new Date().toISOString().slice(0, 10)}.db`;
    fs.writeFileSync(out, snap.data); console.log(`Wrote ${out} (${snap.data.length} bytes, saved ${new Date(snap.at).toISOString()})`);
  }
  await store.close();
})().catch((e) => { console.error(redact(e.message)); process.exit(1); });
