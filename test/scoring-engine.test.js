'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/lib/scoring');
const P = require('../src/lib/points');
const { open, getSettings } = require('../src/db');
const { miniSociety, startApp, Client, addRelativeEvent, seedDemoPlusEvents } = require('./helpers');

const holes = Array.from({ length: 18 }, (_, i) => ({ par: [4, 3, 5][i % 3], si: i + 1 }));
const course = { par: 72, rating: 71, slope: 130, holes };

test('allowances: course/playing/team handicaps and strokes per hole', () => {
  assert.equal(E.playingHandicap(E.courseHandicap(15, course), 95), 15);
  assert.equal(E.teamHandicap([20, 4, 12, 8], [0.25, 0.2, 0.15, 0.1]), 6); // 1+1.6+1.8+2 = 6.4
  assert.equal(E.strokesOnHole(20, 2), 2); assert.equal(E.strokesOnHole(20, 3), 1);
  assert.equal(E.strokesOnHole(-2, 18), -1); assert.equal(E.strokesOnHole(-2, 16), 0);
  assert.equal(E.capHole(9, 4, 1, { type: 'net_double_bogey' }), 7);
});

test('formats: hole-by-hole stableford / par-bogey / totals / better-ball / matchplay', () => {
  const card = { holes: holes.map((h) => h.par) }; // level par gross, ph 18 => 3 pts every hole
  const s = E.scoreCard(card, course, 18);
  assert.equal(s.stableford, 54); assert.equal(s.gross, 72); assert.equal(s.net, 54); assert.equal(s.parBogey, 18);
  assert.deepEqual(E.scoreCard({ total: { gross: 88 } }, course, 15), { gross: 88, net: 73, stableford: 35, parBogey: null, holes: null });
  const a = E.scoreCard({ holes: holes.map((h, i) => h.par + (i % 2)) }, course, 0);
  const b = E.scoreCard({ holes: holes.map((h, i) => h.par + ((i + 1) % 2)) }, course, 0);
  assert.equal(E.betterBall([a, b]).stableford, 36);
  const mp = E.matchplay([3, 4, 4, 4], [4, 4, 4, 4]);
  assert.equal(mp.result, 'A'); assert.equal(mp.label, '1 up');
  assert.equal(E.matchplay([3, 3, 4, 4], [4, 4, 4, 4]).label, '2&1');
});

test('ranking: ties share, countback splits on back 9, position_in overrides', () => {
  const back = (n) => holes.map((_, i) => ({ pts: i >= 9 ? n : 2, net: 0 }));
  const r = E.rank([{ key: 'a', value: 36, holes: back(2) }, { key: 'b', value: 36, holes: back(3) }, { key: 'c', value: 30 }], { tieBreak: 'countback' });
  assert.deepEqual([r.get('b'), r.get('a'), r.get('c')], [1, 2, 3]);
  const r2 = E.rank([{ key: 'a', value: 36 }, { key: 'b', value: 36 }, { key: 'c', value: 30, position_in: 1 }]);
  assert.deepEqual([r2.get('a'), r2.get('b'), r2.get('c')], [1, 1, 1]);
});

test('points: positions, multiplier, bonuses and last-place penalty (fantasy-style)', () => {
  const cfg = { mode: 'points', positions: [25, 18, 15], participation: 0, bonuses: [{ when: 'played', pts: 3 }, { when: 'birdies', pts: 2 }, { when: 'stableford>=36', pts: 3 }, { when: 'last', pts: -5 }] };
  const out = E.scoreEvent([{ key: 1, stableford: 40, birdies: 2 }, { key: 2, stableford: 30 }, { key: 3, stableford: 20 }], null, { format: 'stableford', points: cfg });
  assert.deepEqual(out.map((o) => o.points), [25 + 3 + 4 + 3, 18 + 3, 15 + 3 - 5]);
  assert.equal(E.pointsFor({}, 1, { positions: [10] }, { multiplier: 2 }), 20);
});

test('presets normalise to safe configs; league table honours chosen events and best N', () => {
  for (const k of Object.keys(E.PRESETS)) assert.equal(E.normalise({ ...E.PRESETS[k], preset: k }).preset, k);
  assert.equal(E.normalise({ format: 'evil', allowance: { pct: 900 } }).allowance.pct, 100);
  const t = E.leagueTable([{ user: 1, event: 1, points: 10 }, { user: 1, event: 2, points: 5 }, { user: 2, event: 1, points: 12 }, { user: 2, event: 3, points: 99 }], { events: [1, 2], bestN: 1 });
  assert.deepEqual(t.map((r) => [r.user, r.total]), [[2, 12], [1, 10]]);
});

test('GOLDEN: classic preset reproduces stored position and points', () => {
  const { db, season, course, ids } = miniSociety([10, 15, 20, 25]);
  const { saveResults } = require('../src/lib/results');
  const { recomputeAll } = require('../src/lib/engine');
  for (const [i, days] of [-28, -21, -14].entries()) {
    const ev = addRelativeEvent(db, { season, course, days, title: 'Round ' + (i + 1), status: 'completed' });
    saveResults(db, ev, ids.map((u, k) => ({ user_id: u, stableford: 40 - k - i })));
  }
  recomputeAll(db);
  const S = getSettings(db); const def = P.parseScheme(S.oom_default_scheme);
  const events = db.prepare("SELECT e.*, s.scheme AS season_scheme FROM events e JOIN seasons s ON s.id=e.season_id WHERE e.status!='cancelled'").all();
  let n = 0;
  for (const e of events) {
    const rows = db.prepare('SELECT * FROM results WHERE event_id=?').all(e.id);
    if (!rows.length) continue;
    const cfg = E.classicConfig(e, P.parseScheme(e.season_scheme, def));
    const out = E.scoreEvent(rows.map((r) => ({ key: r.id, ph: r.playing_handicap, stableford: r.stableford, net: r.net, gross: r.gross != null ? r.gross : r.ags, position_in: r.position_in, bonus: r.bonus })), null, cfg, { multiplier: e.points_multiplier });
    for (const o of out) { const r = rows.find((x) => x.id === o.key); assert.equal(o.position, r.position, `event ${e.id} pos`); assert.equal(o.points, r.points, `event ${e.id} pts`); n++; }
  }
  assert.ok(n >= 12, `checked ${n} results`);
});

test('migrations are idempotent and leave existing data alone', () => {
  const p = require('path').join(require('os').tmpdir(), `eng-${process.pid}.db`);
  const db = open(p); require('../scripts/seed-demo-site').seedDemo(db); seedDemoPlusEvents({ db });
  const before = db.prepare('SELECT COUNT(*) n, SUM(points) p FROM results').get(); db.close();
  const db2 = open(p); const db3 = open(p);
  assert.deepEqual(db3.prepare('SELECT COUNT(*) n, SUM(points) p FROM results').get(), before);
  assert.ok(db2.prepare("SELECT 1 FROM sqlite_master WHERE name='competition_types'").get());
  db2.close(); db3.close(); for (const s of ['', '-wal', '-shm']) try { require('fs').unlinkSync(p + s); } catch {}
});

test('admin can create and edit a competition type from a preset; members cannot', async () => {
  const m = miniSociety([10, 20]);
  m.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(m.ids[0]);
  const srv = await startApp(m.db);
  try {
    const a = new Client(srv.base); await a.login('p1@t.example');
    const g = await a.get('/admin/competition-types?preset=texas_scramble'); assert.equal(g.status, 200); assert.match(g.text_, /Texas scramble/);
    const r = await a.post('/admin/competition-types', { name: 'Spring Scramble', preset: 'texas_scramble', format: 'stroke_net', allowance_pct: '100', positions: '10, 6, 4', participation: '2', bonus_last: '-5', countback: '1' });
    assert.equal(r.status, 302);
    const row = m.db.prepare('SELECT * FROM competition_types').get(); const c = JSON.parse(row.config);
    assert.deepEqual(c.points.positions, [10, 6, 4]); assert.deepEqual(c.team.weights, [0.25, 0.2, 0.15, 0.1]); assert.deepEqual(c.points.bonuses, [{ when: 'last', pts: -5 }]);
    await a.post('/admin/competition-types', { id: String(row.id), name: 'Renamed', preset: 'texas_scramble', format: 'stroke_net', allowance_pct: '90', positions: '5' });
    assert.equal(m.db.prepare('SELECT name FROM competition_types').get().name, 'Renamed');
    const u = new Client(srv.base); await u.login('p2@t.example');
    assert.notEqual((await u.get('/admin/competition-types')).status, 200);
  } finally { await srv.close(); }
});

test('generic events: link a type, enter hole-by-hole + totals, results with snapshot, leagues, feature flag', async () => {
  const m = miniSociety([10, 20, 5, 15]);
  const { db, ids } = m; db.prepare("UPDATE users SET role='admin' WHERE id=?").run(ids[0]);
  const ev = db.prepare("INSERT INTO events(season_id,title,course_id,event_date) VALUES (?,?,?,?)").run(m.season, 'Pairs Day', m.course, '2026-07-01').lastInsertRowid;
  const srv = await startApp(db);
  try {
    const a = new Client(srv.base); await a.login('p1@t.example');
    await a.post('/admin/competition-types', { name: 'Medal', preset: 'medal_net', format: 'stroke_net', allowance_pct: '95', positions: '10,6,4', bonus_birdie: '2', bonus_last: '-5' });
    const t = db.prepare("SELECT id FROM competition_types WHERE name='Medal'").get().id;
    const pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5]; const sis = [7, 11, 15, 1, 9, 3, 17, 13, 5, 8, 16, 2, 6, 12, 4, 18, 14, 10];
    await a.post(`/admin/engine/courses/${m.course}/holes`, { pars: pars.join(','), sis: sis.join(',') });
    assert.equal(JSON.parse(db.prepare('SELECT holes FROM courses WHERE id=?').get(m.course).holes).length, 18);
    assert.equal((await a.post('/admin/engine/link', { event_id: String(ev), competition_type_id: String(t) })).status, 302);
    assert.equal((await a.get(`/admin/engine/events/${ev}`)).status, 200);
    const card = pars.map((p, i) => (i === 0 ? p - 1 : p)).join(',');
    const r = await a.post(`/admin/engine/events/${ev}/scores`, { [`holes_${ids[0]}`]: card, [`gross_${ids[1]}`]: '95', [`gross_${ids[2]}`]: '80', [`holes_${ids[3]}`]: '4,4' });
    assert.match(r.headers.get('location'), /error=/);
    await a.post(`/admin/engine/events/${ev}/scores`, { [`holes_${ids[0]}`]: card, [`gross_${ids[1]}`]: '95', [`gross_${ids[2]}`]: '80' });
    const res = db.prepare('SELECT * FROM engine_results WHERE event_id=? ORDER BY position').all(ev);
    assert.equal(res.length, 3); assert.equal(res[0].user_id, ids[0]); assert.equal(res[0].points, 12); // 1st (10) + 1 birdie (2)
    assert.equal(res[2].points, 4 - 5); assert.equal(JSON.parse(res[0].config_snapshot).format, 'stroke_net');
    assert.match((await new Client(srv.base).get(`/comp-results/${ev}`)).text_, /Player 1/);
    await a.post('/admin/leagues', { name: 'Medal League', types: String(t) });
    const L = db.prepare("SELECT id FROM leagues WHERE name='Medal League'").get().id;
    assert.match((await new Client(srv.base).get(`/leagues/${L}`)).text_, /Medal League[\s\S]*Player 1/);
    assert.equal((await new Client(srv.base).get('/admin/engine')).status === 200, false);
    db.prepare("UPDATE settings SET value='0' WHERE key='feature_engine'").run();
    assert.equal((await new Client(srv.base).get(`/leagues/${L}`)).status, 404);
  } finally { await srv.close(); }
});
