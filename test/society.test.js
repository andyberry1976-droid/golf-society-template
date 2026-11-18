'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { memDb, miniSociety, addEvent, addRelativeEvent, startApp, Client } = require('./helpers');
const { setSetting, open } = require('../src/db');
const Soc = require('../src/lib/society');
const P = require('../src/lib/points');
const comps = require('../src/lib/comps');
const standings = require('../src/lib/standings');
const { saveResults } = require('../src/lib/results');
const { recomputeAll, tournamentBoard } = require('../src/lib/engine');

const SCORE_SCHEME = JSON.stringify({ mode: 'score', bestN: 7, countback: true });

test('Order of Merit: best 7 stableford scores count, 8th breaks ties, then appearances', () => {
  const s = miniSociety([10, 10, 10, 10]);
  setSetting(s.db, 'oom_default_scheme', SCORE_SCHEME);
  const [a, b, c, d] = s.ids;
  // a: 8 rounds, b: 8 rounds with the same best 7 but a lower 8th, c: 9 rounds, d: 1 round of 40
  const A = [36, 35, 34, 33, 32, 31, 30, 29];
  const B = [36, 35, 34, 33, 32, 31, 30, 20];
  const C = [40, 40, 30, 30, 30, 30, 30, 10, 10];
  for (let i = 0; i < 9; i++) {
    const ev = addEvent(s.db, { season: s.season, course: s.course, title: `M${i}`, date: `2026-0${1 + Math.floor(i / 2)}-${10 + (i % 2)}`, hcp: 0 });
    const rows = [];
    if (A[i] != null) rows.push({ user_id: a, stableford: A[i] });
    if (B[i] != null) rows.push({ user_id: b, stableford: B[i] });
    rows.push({ user_id: c, stableford: C[i] });
    if (i === 0) rows.push({ user_id: d, stableford: 40 });
    saveResults(s.db, ev, rows);
  }
  const om = standings.orderOfMerit(s.db, s.season);
  const by = Object.fromEntries(om.map((o) => [o.user_id, o]));
  assert.equal(by[a].total, 36 + 35 + 34 + 33 + 32 + 31 + 30); // 231, 29 dropped
  assert.equal(by[b].total, 231);
  assert.equal(by[c].total, 40 + 40 + 30 * 5); // 230
  assert.equal(by[a].counted, 7);
  assert.equal(by[a].dropped, 1);
  assert.deepEqual(om.map((o) => o.user_id).slice(0, 3), [a, b, c]); // a beats b on the 8th score (29 v 20)
  assert.equal(by[a].rank, 1); assert.equal(by[b].rank, 2);
  // appearances decide when the countback can't
  const x = { total: 50, rest: [], played: 3 }; const y = { total: 50, rest: [], played: 2 };
  assert.ok(P.compareCountback(x, y) < 0);
  assert.equal(P.compareCountback({ total: 5, rest: [3], played: 2 }, { total: 5, rest: [3], played: 2 }), 0);
});

test('society handicap adjustment: buffer zone, category cuts, +0.2, 40+ and winner cuts', () => {
  assert.equal(Soc.category(3.1), 1); assert.equal(Soc.category(8.5), 2); assert.equal(Soc.category(12.9), 2);
  assert.equal(Soc.category(13.6), 3); assert.equal(Soc.category(21.6), 3); assert.equal(Soc.category(22.8), 4);
  assert.equal(Soc.playingFromIndex(8.5), 9); assert.equal(Soc.playingFromIndex(21.3), 21); assert.equal(Soc.playingFromIndex(18.6), 19);
  assert.equal(Soc.societyAdjustment(10, 34).delta, 0);            // buffer
  assert.equal(Soc.societyAdjustment(10, 32).delta, 0.2);          // under 33
  assert.equal(Soc.societyAdjustment(10, 38).delta, -0.4);         // cat 2: 2 over x 0.2
  assert.equal(Soc.societyAdjustment(25, 38).delta, -0.8);         // cat 4: 2 over x 0.4
  assert.equal(Soc.societyAdjustment(4, 37).delta, -0.1);          // cat 1
  assert.equal(Soc.societyAdjustment(15, 41).delta, -2.5);         // cat 3: 5 x 0.3 + 1 for 40+
  assert.equal(Soc.societyAdjustment(15, 35, { winnerCut: 1 }).delta, -1);
});

test('society mode in the engine: monthly winner with 9+ players is cut a shot', () => {
  const s = miniSociety(Array(9).fill(15));
  setSetting(s.db, 'handicap_mode', 'society');
  const ev = addEvent(s.db, { season: s.season, course: s.course, date: '2026-03-14' });
  saveResults(s.db, ev, s.ids.map((id, i) => ({ user_id: id, stableford: i === 0 ? 38 : (i === 1 ? 30 : 34) })));
  const idx = (id) => s.db.prepare('SELECT handicap_index FROM users WHERE id=?').get(id).handicap_index;
  assert.equal(idx(s.ids[0]), 15 - 0.6 - 1); // 2 over x 0.3, plus winner cut
  assert.equal(idx(s.ids[1]), 15.2);
  assert.equal(idx(s.ids[2]), 15);
  const r = s.db.prepare('SELECT playing_handicap FROM results WHERE event_id=? AND user_id=?').get(ev, s.ids[0]);
  assert.equal(r.playing_handicap, 15);
});

test('achievement codes parse into titles and badges', () => {
  const a = Soc.parseAchievements('HIOC2, ***, £££, €, FFFFF');
  assert.deepEqual({ ...a, unknown: undefined }, { hioc: 2, major: 3, oom: 3, euro: 1, matchplay: 0, fedex: 5, unknown: undefined });
  const b = Soc.parseAchievements('HIOC, 8*, £, €, 4M, FF');
  assert.equal(b.major, 8); assert.equal(b.matchplay, 4); assert.equal(b.fedex, 2); assert.equal(b.hioc, 1);
  assert.equal(Soc.parseAchievements('HIOC3, ***,€,M').hioc, 3);
  assert.equal(Soc.parseAchievements('HIOC, € ').euro, 1);
  assert.equal(Soc.titleCount(b), 8 + 1 + 1 + 4 + 2);
  assert.ok(Soc.badges(b).some((x) => x.key === 'hioc'));
  assert.deepEqual(Soc.parseAchievements(null).unknown, []);
});

test('Birdie League: eagles count 2, season table totals and holder', () => {
  assert.equal(Soc.birdieValue(3, 1), 5);
  const s = miniSociety([10, 12, 14]);
  const e1 = addEvent(s.db, { season: s.season, course: s.course, date: '2026-01-10' });
  const e2 = addEvent(s.db, { season: s.season, course: s.course, date: '2026-02-14' });
  comps.setCompScores(s.db, 'birdie', e1, [[s.ids[0], Soc.birdieValue(1, 1)], [s.ids[1], 2]]);
  comps.setCompScores(s.db, 'birdie', e2, [[s.ids[1], 0], [s.ids[2], 1]]);
  const t = comps.compTable(s.db, 'birdie', s.season);
  assert.equal(t.events.length, 2);
  assert.deepEqual(t.rows.map((r) => [r.user_id, r.total, r.rank]), [[s.ids[0], 3, 1], [s.ids[1], 2, 2], [s.ids[2], 1, 3]]);
  assert.equal(t.rows.find((r) => r.user_id === s.ids[1]).played, 2);
});

test('FedEx Cup: top 10 score 10..1 and can be filled from finishing positions', () => {
  assert.deepEqual([1, 2, 3, 10, 11, null].map(Soc.fedexPoints), [10, 9, 8, 1, 0, 0]);
  const s = miniSociety([10, 12, 14, 16]);
  const ev = addEvent(s.db, { season: s.season, course: s.course, date: '2026-04-11', hcp: 0 });
  saveResults(s.db, ev, [{ user_id: s.ids[0], stableford: 40 }, { user_id: s.ids[1], stableford: 40 }, { user_id: s.ids[2], stableford: 30 }, { user_id: s.ids[3], stableford: 20 }]);
  const pts = new Map(comps.fedexFromPositions(s.db, ev));
  assert.equal(pts.get(s.ids[0]), 10); assert.equal(pts.get(s.ids[1]), 10); // tie shares 1st
  assert.equal(pts.get(s.ids[2]), 8); assert.equal(pts.get(s.ids[3]), 7);
  comps.setCompScores(s.db, 'fedex', ev, [...pts]);
  assert.equal(comps.compTable(s.db, 'fedex', s.season).rows[0].total, 10);
});

test('matchplay bracket: round names, winners advance, byes', () => {
  assert.deepEqual(Soc.roundNames(5), ['Round 1', 'Round 2', 'Quarter-finals', 'Semi-finals', 'Final']);
  assert.deepEqual(Soc.nextSlot(1, 3), { round: 2, slot: 2, side: 1 });
  assert.deepEqual(Soc.nextSlot(1, 4), { round: 2, slot: 2, side: 2 });
  const s = miniSociety([10, 12, 14, 16]);
  const id = s.db.prepare("INSERT INTO mp_comps(name,size) VALUES ('KO',4)").run().lastInsertRowid;
  comps.saveMatch(s.db, id, 1, 1, { p1: 'Player 1', p2: 'Player 2', winner: 2, result: '2&1' });
  comps.saveMatch(s.db, id, 1, 2, { p1: 'Player 3', p2: 'bye', winner: 1, result: 'Bye' });
  let b = comps.bracket(s.db, id);
  assert.equal(b.rounds.length, 2);
  assert.equal(b.rounds[0].matches[1].p2_name, 'Bye');
  const fin = b.rounds[1].matches[0];
  assert.equal(fin.p1_name, 'Player 2'); assert.equal(fin.p1_id, s.ids[1]);
  assert.equal(fin.p2_name, 'Player 3');
  assert.equal(b.champion, null);
  comps.saveMatch(s.db, id, 2, 1, { p1: 'Player 2', p2: 'Player 3', winner: 1, result: '1 up' });
  b = comps.bracket(s.db, id);
  assert.equal(b.champion, 'Player 2');
});

test('demo seed: members and handicaps, zero events; holders kept', () => {
  process.env.BCRYPT_ROUNDS = '4';
  const db = open(':memory:');
  const { seedDemo } = require('../scripts/seed-demo-site');
  const D = require('../sites/demo/seed/demo-data.json');
  const out = seedDemo(db);
  assert.equal(out.people, D.handicaps.length);
  assert.equal(out.events, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM results').get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE name LIKE '%Player 6%'").get().n, 1);
  for (const h of D.handicaps) {
    const u = db.prepare('SELECT * FROM users WHERE name=?').get(h.name);
    assert.equal(u.handicap_index, h.actual, h.name);
    assert.equal(Soc.playingFromIndex(u.handicap_index), h.playing, h.name + ' playing');
    assert.equal(Soc.category(u.handicap_index), h.cat, h.name + ' category');
  }
  const hon = db.prepare('SELECT c.name, u.name AS who, h.year FROM honours h JOIN honour_categories c ON c.id=h.category_id JOIN users u ON u.id=h.user_id').all();
  assert.ok(hon.some((h) => h.name === 'Order of Merit' && h.who === 'Player 23' && h.year === 2025));
  assert.ok(hon.some((h) => h.name === 'Birdie League' && h.who === 'Player 1' && h.year === 2025));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE password_hash IS NOT NULL").get().n, 3);
});

test('new pages render; members cannot reach the comp admin', async () => {
  process.env.BCRYPT_ROUNDS = '4';
  const db = open(':memory:');
  require('../scripts/seed-demo-site').seedDemo(db);
  const app = await startApp(db);
  try {
    const anon = new Client(app.base);
    for (const p of ['/competitions', '/birdie-league', '/fedex', '/matchplay', '/majors', '/hall-of-fame', '/rules', '/standings', '/players/1']) {
      const r = await anon.get(p); assert.equal(r.status, 200, p);
    }
    assert.match((await anon.get('/standings')).text_, /best 7 count/);
    assert.match((await anon.get('/hall-of-fame')).text_, /hole-in-one club/i);
    assert.doesNotMatch((await anon.get('/players/1')).text_, /Subs paid/);
    const mem = new Client(app.base); await mem.login('member@example.test', 'flamingo-demo-1');
    assert.equal((await mem.get('/admin/comps')).status, 403);
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    const page = await adm.get('/admin/members');
    assert.equal(page.status, 200); assert.match(page.text_, /Unpaid/);
    const ev = addRelativeEvent(db, { days: -14, title: 'January Stableford', status: 'completed' });
    const uid = db.prepare("SELECT id FROM users WHERE name='Player 1'").get().id;
    assert.equal((await adm.post(`/admin/comps/${ev}`, { [`birdies_${uid}`]: '2', [`eagles_${uid}`]: '1', [`fedex_${uid}`]: '7' })).status, 302);
    assert.equal(db.prepare("SELECT value FROM comp_scores WHERE comp='birdie' AND event_id=? AND user_id=?").get(ev, uid).value, 4);
    assert.equal(db.prepare("SELECT value FROM comp_scores WHERE comp='fedex' AND event_id=? AND user_id=?").get(ev, uid).value, 7);
  } finally { await app.close(); }
});

test('handicap records page: ranked by current handicap, badges, subs for admins only', async () => {
  process.env.BCRYPT_ROUNDS = '4';
  const db = open(':memory:');
  require('../scripts/seed-demo-site').seedDemo(db);
  const app = await startApp(db);
  try {
    const anon = new Client(app.base);
    const r = await anon.get('/handicaps');
    assert.doesNotMatch(r.text_, /HIOC|FFFFF|8\*/);
    assert.equal(r.status, 200);
    assert.match(r.text_, /Handicap Records/);
    const i = r.text_.indexOf('Player 1'); const j = r.text_.indexOf('Player 32');
    assert.ok(i > 0 && j > i, 'Player 1 (lowest) listed before Player 32');
    assert.match(r.text_, /Major ×8/); assert.match(r.text_, /Hole-in-one club/);
    assert.doesNotMatch(r.text_, /Subs \(£20\)/);
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    assert.match((await adm.get('/handicaps')).text_, /Subs \(£20\)/);
  } finally { await app.close(); }
});
