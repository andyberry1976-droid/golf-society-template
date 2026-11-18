'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { open, setSetting } = require('../src/db');
const { seedDemo } = require('../scripts/seed-demo-site');
const { startApp, Client, seedDemoPlusEvents } = require('./helpers');

test('site configs: fantasy on for Demo, off for starter', () => {
  assert.equal(JSON.parse(fs.readFileSync('sites/demo/site.config.json')).features.fantasy, true);
  assert.equal(JSON.parse(fs.readFileSync('sites/starter/site.config.json')).features.fantasy, false);
});

test('fantasy league teaser: page + menu link when on, 404 and no link when off', async () => {
  const { db } = seedDemoPlusEvents(); setSetting(db, 'feature_fantasy', '1');
  const app = await startApp(db);
  try {
    const c = new Client(app.base);
    const r = await c.get('/fantasy-league'); assert.equal(r.status, 200);
    assert.match(r.text_, /Coming in 2027/); for (const w of [/£50m to spend on 5 players/, /Captain/, /score double/, /<td>25<\/td><td>18<\/td><td>15<\/td><td>12<\/td><td>10<\/td><td>8<\/td><td>6<\/td><td>4<\/td><td>2<\/td><td>1<\/td>/, /Beat your handicap/, /\+3/, /Wooden spoon/, /Playing:<\/strong> \+3/, /Birdies:<\/strong> \+2 for every gross birdie/, /-5/, /Winner takes the pot/, /leaderboard updates after every event/, /Player prices for 2027/]) assert.match(r.text_, w);
    { const body = r.text_.slice(r.text_.indexOf('<main'), r.text_.indexOf('</main>')); assert.doesNotMatch(body, /[Nn]earest the pin|blob|wipe|Turning up|Order of Merit events|Longest drive|free transfer|Transfer|Matchplay doesn|Rounds<\/th>|pts<\/th>/); }
    assert.doesNotMatch(r.text_, /<form/); assert.ok(r.text_.indexOf('id="fl-pr"') < r.text_.indexOf('id="fl-h"'), 'prices come before the rules'); assert.doesNotMatch(r.text_, /if we can agree|Transfer window|scores double/); { const body = r.text_.slice(r.text_.indexOf('<main'), r.text_.indexOf('</main>')); assert.doesNotMatch(body, /Ryder|Majors|Euro\b/); }
    assert.match((await c.get('/')).text_, /href="\/fantasy-league"/);
    setSetting(db, 'feature_fantasy', '0');
    assert.equal((await c.get('/fantasy-league')).status, 404);
    assert.doesNotMatch((await c.get('/')).text_, /href="\/fantasy-league"/);
  } finally { await app.close(); }
});

test('fantasy scoring: place points, ties split, +3 for 36+, wooden spoon; prices file sane', () => {
  const F = require('../src/lib/fantasy');
  assert.equal(F.placePoints(1), 25); assert.equal(F.placePoints(10), 1); assert.equal(F.placePoints(11), 0);
  assert.equal(F.placePoints(2, 2), (18 + 15) / 2);
  const { db } = seedDemoPlusEvents();
  const sim = F.simulate(db, 2026); assert.ok(sim.length > 5);
  const ev = db.prepare("SELECT e.id FROM events e JOIN seasons s ON s.id=e.season_id WHERE s.year=2026 AND e.status='completed' ORDER BY e.event_date LIMIT 1").get();
  const rows = db.prepare('SELECT user_id, position, stableford FROM results WHERE event_id=?').all(ev.id);
  assert.ok(rows.length > 0);
  const P = F.livePrices(db, 2026);
  const pr = P.players.map((p) => p.price);
  for (const x of pr) { assert.ok(x >= 3 && x <= 13); assert.equal(x * 2, Math.round(x * 2)); }
  for (let i = 1; i < pr.length; i++) assert.ok(pr[i - 1] >= pr[i], 'sorted by price');
});

test('fantasy: rules configurable per society and prices generated from data when no file', () => {
  const F = require('../src/lib/fantasy'); const { open } = require('../src/db');
  const { R, places } = F.rulesFrom({ fantasy_rules: JSON.stringify({ budget: 80, played: 1, places: [10, 5] }) });
  assert.equal(R.budget, 80); assert.equal(R.squad, 5); assert.deepEqual(places, [10, 5]);
  const { db } = seedDemoPlusEvents();
  const p = F.livePrices(db, 2026, { R, places }); assert.ok(p.players.length > 10);
  assert.ok(p.players.every((x) => x.price >= 3 && x.price <= 13)); assert.ok(p.players[0].price >= p.players.at(-1).price);
});
