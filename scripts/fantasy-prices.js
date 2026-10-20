'use strict';
// Optional: freeze prices into sites/<site>/fantasy-prices.json (otherwise the page generates them live from the data).
//   node scripts/fantasy-prices.js <db> [year] [site]   — the file can be hand-edited afterwards.
const fs = require('fs');
const F = require('../src/lib/fantasy');
const [dbPath, year = String(new Date().getFullYear()), site = process.env.SITE || 'demo'] = process.argv.slice(2);
const db = require('better-sqlite3')(dbPath, { readonly: true });
const S = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((r) => [r.key, r.value]));
const { R, places } = F.rulesFrom(S);
const out = F.livePrices(db, Number(year), { R, places });
fs.writeFileSync(`sites/${site}/fantasy-prices.json`, JSON.stringify(out, null, 1) + '\n');
console.log(out ? out.players.length : 0, 'players');
