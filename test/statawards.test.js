'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, Client, seedDemoPlusEvents } = require('./helpers');
const SA = require('../src/lib/statawards');

test('stats awards: computed from real scores, per season and all-time; update when a score is added', async () => {
  const { db } = seedDemoPlusEvents();
  const sid = (y) => db.prepare('SELECT id FROM seasons WHERE year=?').get(y).id;
  const best = db.prepare(`SELECT MAX(r.stableford) m FROM results r JOIN events e ON e.id=r.event_id WHERE e.status='completed'`).get().m;
  const at = SA.allTime(db);
  assert.equal(at.cards.find((c) => c.key === 'best').value, `${best} pts`);
  const s26 = SA.forSeason(db, sid(2026));
  for (const k of ['best', 'worst', 'birdies', 'rounds', 'wins', 'avg', 'margin', 'streak', 'spoon']) assert.ok(s26.cards.some((c) => c.key === k), k);
  // live update: a record round moves the award
  const r = db.prepare(`SELECT r.id, r.user_id FROM results r JOIN events e ON e.id=r.event_id WHERE e.season_id=? AND e.status='completed' LIMIT 1`).get(sid(2026));
  db.prepare('UPDATE results SET stableford=? WHERE id=?').run(best + 5, r.id);
  assert.equal(SA.allTime(db).cards.find((c) => c.key === 'best').value, `${best + 5} pts`);
  const app = await startApp(db);
  try {
    const t = (await new Client(app.base).get('/awards')).text_;
    assert.match(t, /By the numbers/); assert.match(t, /All-time/); assert.match(t, /Wooden spoon/);
  } finally { await app.close(); }
});
