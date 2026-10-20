'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, setSetting } = require('../src/db');
const { seedDemo } = require('../scripts/seed-demo-site');
const { startApp, Client } = require('./helpers');
const S = require('../src/lib/scramble');
const site = require('../src/site').load('demo');

test('Texas scramble: page, joint places, member links, no effect on OoM/stats', async () => {
  const db = open(':memory:'); seedDemo(db);
  const before = { res: db.prepare('SELECT COUNT(*) n FROM results').get().n, ev: db.prepare('SELECT COUNT(*) n FROM events').get().n };
  assert.equal(S.ensureFromSite(db, site), 1); assert.equal(S.ensureFromSite(db, site), 0, 'idempotent');
  const hc = db.prepare('SELECT id, handicap_index FROM users ORDER BY id').all();
  db.prepare("UPDATE team_events SET src_hash='old'").run(); assert.equal(S.ensureFromSite(db, site), 1, 'changed source replaces the event');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM team_events').get().n, 1); assert.deepEqual(db.prepare('SELECT id, handicap_index FROM users ORDER BY id').all(), hc, 'society handicaps untouched');
  assert.deepEqual({ res: db.prepare('SELECT COUNT(*) n FROM results').get().n, ev: db.prepare('SELECT COUNT(*) n FROM events').get().n }, before);
  const [e] = S.list(db);
  assert.equal(e.event_date, null); assert.equal(e.results.length, 7);
  assert.deepEqual(e.results.map((r) => r.team.slice(0, 12)), ['Team Legends', 'Team Two', 'Team Four', 'Team Loaded', 'Team Three', 'Team Five']. concat(['Team Six']));
  assert.deepEqual(e.results.filter((r) => r.joint).map((r) => r.position), [2, 2, 5, 5]);
  setSetting(db, 'feature_scramble', '1');
  const app = await startApp(db);
  try {
    const c = new Client(app.base); const t = (await c.get('/texas-scramble')).text_;
    assert.match(t, /Sample Texas Scramble/); assert.match(t, /Willow Lakes · Date TBC/); assert.match(t, /Team Two/);
    assert.match(t, /<td>T2<\/td>/); assert.match(t, /<a href="\/players\/\d+">Admin<\/a> <span class="mute">\(9\)<\/span>/); assert.match(t, /<a href="\/players\/\d+">Player 17<\/a>/);
    assert.doesNotMatch(t, />Player 28</); assert.doesNotMatch(t, /<a href="\/players\/\d+">(Player 8|Player 1)<\/a>/, 'duplicated names stay unlinked'); assert.match(t, /Player 33/); assert.match(t, />−18</);
    setSetting(db, 'feature_scramble', '0'); assert.equal((await c.get('/texas-scramble')).status, 404);
  } finally { await app.close(); }
});
