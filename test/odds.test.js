'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, Client, seedDemoPlusEvents } = require('./helpers');
const O = require('../src/lib/odds');

test('fractions: rounded down to the standard ladder', () => {
  assert.equal(O.toFraction(3.6), '7/2'); assert.equal(O.toFraction(12.4), '12/1'); assert.equal(O.toFraction(1), 'Evens'); assert.equal(O.toFraction(0.95), '10/11');
});

test('odds: next upcoming event only, favourite first, stable, react to scores, gone once results exist', async () => {
  const { db } = seedDemoPlusEvents();
  const today = require('../src/lib/queries').today();
  const nx = O.nextEvent(db, today); assert.ok(nx);
  const a = O.compute(db, nx); const b = O.compute(db, nx);
  assert.deepEqual(a.players.map((p) => p.odds), b.players.map((p) => p.odds), 'seeded: same odds on refresh');
  assert.equal(a.players.length, require('../src/lib/field').list(db, nx.id).length);
  for (let i = 1; i < a.players.length; i++) assert.ok(a.players[i - 1].oddsValue <= a.players[i].oddsValue);
  const book = a.players.reduce((s, p) => s + 1 / (p.oddsValue + 1), 0);
  assert.ok(book > 1.02 && book < 1.4, `overround ${book}`);
  // a long shot who suddenly posts big scores shortens
  const last = a.players.at(-1);
  const evs = db.prepare(`SELECT e.id FROM events e WHERE e.season_id=? AND e.status='completed' AND e.tournament_id IS NULL ORDER BY e.event_date DESC LIMIT 3`).all(nx.season_id);
  for (const e of evs) db.prepare(`INSERT INTO results(event_id,user_id,stableford_in,stableford) VALUES (?,?,48,48) ON CONFLICT(event_id,user_id) DO UPDATE SET stableford=48, stableford_in=48`).run(e.id, last.id);
  const c = O.compute(db, nx);
  assert.ok(c.players.find((p) => p.id === last.id).oddsValue < last.oddsValue);
  const app = await startApp(db);
  try {
    const get = async (id) => (await new Client(app.base).get('/events/' + id)).text_;
    const page = await get(nx.id);
    assert.match(page, /id="odds-h">The odds/); assert.match(page, /For fun only · no betting/);
    const other = db.prepare("SELECT id FROM events WHERE status='scheduled' AND id!=? LIMIT 1").get(nx.id);
    if (other) assert.doesNotMatch(await get(other.id), /id="odds-h"/);
    require('../src/db').setSetting(db, 'feature_odds', '0');
    assert.doesNotMatch(await get(nx.id), /id="odds-h"/, 'feature switch hides it');
    require('../src/db').setSetting(db, 'feature_odds', '1');
    // results in → odds disappear on that page
    db.prepare('INSERT INTO results(event_id,user_id,stableford_in,stableford) VALUES (?,?,30,30)').run(nx.id, a.players[0].id);
    assert.doesNotMatch(await get(nx.id), /id="odds-h"/);
  } finally { await app.close(); }
});
