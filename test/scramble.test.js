'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open, setSetting } = require('../src/db');
const { seedDemo } = require('../scripts/seed-demo-site');
const { startApp, Client } = require('./helpers');
const S = require('../src/lib/scramble');

const SAMPLE = [
  {
    slug: '2026-spring-texas-scramble',
    year: 2026,
    title: 'Spring Texas Scramble',
    course: 'Riverside Park',
    event_date: null,
    format: 'Scramble stroke play (net)',
    results: [
      { position: 1, team: 'Team Legends', hcp: 11, score: 53, to_par: -18, players: [
        { name: 'Admin', hcp: 9 }, { name: 'Player 17', hcp: 17 }, { name: 'Player 13', hcp: 20 }, { name: 'Player 33', hcp: 28 },
      ] },
      { position: 2, team: 'Fairway Four', hcp: null, score: 53, to_par: -18, players: [
        { name: 'Player 7', hcp: 10 }, { name: 'Player 20', hcp: 28 }, { name: 'Player 8', hcp: 8 }, { name: 'Player 1', hcp: 6 },
      ] },
      { position: 2, team: 'The Cutters', hcp: 11, score: 54, to_par: -17, players: [
        { name: 'Player 8', hcp: 20 }, { name: 'Player 15', hcp: 18 }, { name: 'Player 23', hcp: 20 }, { name: 'Player 5', hcp: 9 },
      ] },
      { position: 4, team: 'Last Cart', hcp: 12, score: 57, to_par: -14, players: [
        { name: 'Player 6', hcp: 10 }, { name: 'Player 18', hcp: 18 }, { name: 'Player 11', hcp: 28 }, { name: 'Player 1', hcp: 22 },
      ] },
    ],
  },
];

function siteWith(events) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scramble-'));
  fs.writeFileSync(path.join(dir, 'team-events.json'), JSON.stringify(events));
  return { dir };
}

test('Texas scramble: page, joint places, member links, no effect on OoM/stats', async () => {
  const db = open(':memory:'); seedDemo(db);
  const before = { res: db.prepare('SELECT COUNT(*) n FROM results').get().n, ev: db.prepare('SELECT COUNT(*) n FROM events').get().n };
  const site = siteWith(SAMPLE);
  assert.equal(S.ensureFromSite(db, site), 1); assert.equal(S.ensureFromSite(db, site), 0, 'idempotent');
  const hc = db.prepare('SELECT id, handicap_index FROM users ORDER BY id').all();
  db.prepare("UPDATE team_events SET src_hash='old'").run(); assert.equal(S.ensureFromSite(db, site), 1, 'changed source replaces the event');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM team_events').get().n, 1); assert.deepEqual(db.prepare('SELECT id, handicap_index FROM users ORDER BY id').all(), hc, 'society handicaps untouched');
  assert.deepEqual({ res: db.prepare('SELECT COUNT(*) n FROM results').get().n, ev: db.prepare('SELECT COUNT(*) n FROM events').get().n }, before);
  const [e] = S.list(db);
  assert.equal(e.event_date, null); assert.equal(e.results.length, 4);
  assert.deepEqual(e.results.map((r) => r.team), ['Team Legends', 'Fairway Four', 'The Cutters', 'Last Cart']);
  assert.deepEqual(e.results.filter((r) => r.joint).map((r) => r.position), [2, 2]);
  setSetting(db, 'feature_scramble', '1');
  const app = await startApp(db);
  try {
    const c = new Client(app.base); const t = (await c.get('/texas-scramble')).text_;
    assert.match(t, /Spring Texas Scramble/); assert.match(t, /Riverside Park · Date TBC/); assert.match(t, /Fairway Four/);
    assert.match(t, /<td>T2<\/td>/); assert.match(t, /<a href="\/players\/\d+">Admin<\/a> <span class="mute">\(9\)<\/span>/); assert.match(t, /<a href="\/players\/\d+">Player 17<\/a>/);
    assert.doesNotMatch(t, />Player 28</); assert.doesNotMatch(t, /<a href="\/players\/\d+">(Player 8|Player 1)<\/a>/, 'duplicated names stay unlinked'); assert.match(t, /Player 33/); assert.match(t, />−18</);
    setSetting(db, 'feature_scramble', '0'); assert.equal((await c.get('/texas-scramble')).status, 404);
  } finally { await app.close(); }
});
