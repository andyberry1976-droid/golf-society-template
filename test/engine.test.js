'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { miniSociety, addEvent } = require('./helpers');
const { saveResults } = require('../src/lib/results');
const { recomputeAll } = require('../src/lib/engine');
const standings = require('../src/lib/standings');
const stats = require('../src/lib/stats');
const H = require('../src/lib/handicap');

const idx = (db, id) => db.prepare('SELECT handicap_index v FROM users WHERE id=?').get(id).v;
const res = (db, ev, uid) => db.prepare('SELECT * FROM results WHERE event_id=? AND user_id=?').get(ev, uid);

test('saving results derives playing handicap, net, stableford, differential', () => {
  const { db, season, course, ids } = miniSociety([15]);
  const ev = addEvent(db, { season, course, date: '2026-04-04' });
  saveResults(db, ev, [{ user_id: ids[0], gross: 88 }]);
  const r = res(db, ev, ids[0]);
  // course handicap = 15*130/113 + (71-72) = 16.26 -> 16 ; playing = 95% -> 15
  assert.equal(r.course_handicap, 16);
  assert.equal(r.playing_handicap, 15);
  assert.equal(r.net, 73);
  assert.equal(r.stableford, 36 + 72 + 15 - 88); // 35
  assert.equal(r.differential, H.scoreDifferential({ ags: 88, rating: 71, slope: 130 })); // 113/130*17 = 14.8
  assert.equal(r.idx_at_event, 15);
  assert.equal(db.prepare('SELECT status FROM events WHERE id=?').get(ev).status, 'completed');
});

test('stableford-only entry implies an adjusted gross', () => {
  const { db, season, course, ids } = miniSociety([15]);
  const ev = addEvent(db, { season, course });
  saveResults(db, ev, [{ user_id: ids[0], stableford: 40 }]);
  const r = res(db, ev, ids[0]);
  assert.equal(r.ags, 72 + 15 + 36 - 40); // 83
  assert.equal(r.net, 83 - 15);
});

test('handicap stays put until 3 rounds, then follows the WHS table', () => {
  const { db, season, course, ids } = miniSociety([20]);
  const evs = [1, 2, 3, 4].map((i) => addEvent(db, { season, course, title: 'E' + i, date: `2026-0${i}-04` }));
  saveResults(db, evs[0], [{ user_id: ids[0], gross: 90 }]);
  assert.equal(idx(db, ids[0]), 20);
  saveResults(db, evs[1], [{ user_id: ids[0], gross: 92 }]);
  assert.equal(idx(db, ids[0]), 20);
  saveResults(db, evs[2], [{ user_id: ids[0], gross: 95 }]);
  // diffs: (90-71)*113/130=16.5, (92-71)=18.3, (95-71)=20.9 -> lowest 1 (16.5) - 2.0 = 14.5
  assert.equal(idx(db, ids[0]), 14.5);
  saveResults(db, evs[3], [{ user_id: ids[0], gross: 80 }]);
  // 4 rounds: lowest 1 (7.8) -1.0 = 6.8 -> soft cap is irrelevant (falling); hard/soft only limit rises
  assert.equal(idx(db, ids[0]), 6.8);
  const hist = db.prepare('SELECT * FROM handicap_history WHERE user_id=? ORDER BY seq').all(ids[0]);
  assert.equal(hist.length, 5); // initial + 4 rounds
  assert.equal(hist[0].source, 'initial');
  assert.equal(hist.at(-1).index_after, 6.8);
  assert.equal(hist.at(-1).index_before, 14.5);
});

test('editing an older result re-flows later handicaps; deleting results rewinds', () => {
  const { db, season, course, ids } = miniSociety([20]);
  const evs = [1, 2, 3, 4].map((i) => addEvent(db, { season, course, title: 'E' + i, date: `2026-0${i}-04` }));
  [90, 92, 95, 100].forEach((g, i) => saveResults(db, evs[i], [{ user_id: ids[0], gross: g }]));
  const before = idx(db, ids[0]);
  saveResults(db, evs[0], [{ user_id: ids[0], gross: 80 }]); // old round was actually much better
  assert.ok(idx(db, ids[0]) < before);
  assert.equal(res(db, evs[3], ids[0]).idx_at_event, res(db, evs[3], ids[0]).idx_at_event); // sanity
  saveResults(db, evs[0], []);
  saveResults(db, evs[1], []);
  saveResults(db, evs[2], []);
  saveResults(db, evs[3], []);
  assert.equal(idx(db, ids[0]), 20); // back to the starting handicap
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE status='completed'").get().n, 0);
});

test('team formats and counts_handicap=0 events never touch the handicap', () => {
  const { db, season, course, ids } = miniSociety([20, 20, 20]);
  const evs = [1, 2, 3, 4].map((i) => addEvent(db, { season, course, title: 'T' + i, date: `2026-0${i}-04`, format: 'scramble', basis: 'manual', hcp: 0 }));
  evs.forEach((e) => saveResults(db, e, ids.map((id) => ({ user_id: id, position: 1, gross: 60 }))));
  ids.forEach((id) => assert.equal(idx(db, id), 20));
});

test('soft + hard caps limit how fast a bad run can raise the index', () => {
  const { db, season, course, ids } = miniSociety([10]);
  const day = (i) => new Date(Date.UTC(2026, 0, 3) + i * 7 * 86400000).toISOString().slice(0, 10);
  const evs = Array.from({ length: 40 }, (_, i) => addEvent(db, { season, course, title: 'E' + i, date: day(i) }));
  evs.slice(0, 20).forEach((e) => saveResults(db, e, [{ user_id: ids[0], gross: 72 }])); // diff ~0.9 each
  const low = idx(db, ids[0]);
  assert.ok(low < 3, 'index falls with great scores, got ' + low);
  evs.slice(20).forEach((e) => saveResults(db, e, [{ user_id: ids[0], gross: 130 }])); // 20 disasters
  const after = idx(db, ids[0]);
  const lowest = db.prepare('SELECT MIN(index_after) m FROM handicap_history WHERE user_id=?').get(ids[0]).m;
  assert.ok(after > low, 'index still rose');
  assert.ok(after <= lowest + 5 + 1e-9, `hard cap: ${after} <= ${lowest}+5`);
  // without caps the same data would be far higher
  db.prepare("UPDATE settings SET value='0' WHERE key IN ('soft_cap','hard_cap')").run();
  recomputeAll(db);
  assert.ok(idx(db, ids[0]) > after + 10, 'uncapped index is much higher');
});

test('manual override sets the baseline, later rounds adjust it', () => {
  const { db, season, course, ids } = miniSociety([20]);
  db.prepare("INSERT INTO handicap_adjustments(user_id,effective_on,index_value,kind,note) VALUES (?,?,?,?,?)").run(ids[0], '2026-02-01', 12.0, 'manual', 'admin');
  recomputeAll(db);
  assert.equal(idx(db, ids[0]), 12);
  const ev = addEvent(db, { season, course, date: '2026-03-07' });
  saveResults(db, ev, [{ user_id: ids[0], gross: 90 }]);
  assert.equal(idx(db, ids[0]), 12); // only one differential so far
  assert.equal(res(db, ev, ids[0]).idx_at_event, 12);
});

test('general-play (extra) rounds feed the index', () => {
  const { db, ids } = miniSociety([20]);
  for (const [d, a] of [['2026-01-10', 80], ['2026-01-17', 84], ['2026-01-24', 86]]) {
    db.prepare('INSERT INTO extra_rounds(user_id,played_on,course_name,ags,rating,slope,par) VALUES (?,?,?,?,?,?,?)').run(ids[0], d, 'Away', a, 71, 130, 72);
  }
  recomputeAll(db);
  assert.equal(idx(db, ids[0]), H.round1(H.scoreDifferential({ ags: 80, rating: 71, slope: 130 }) - 2));
});

test('positions: stableford desc with ties; net asc; manual override wins', () => {
  const { db, season, course, ids } = miniSociety([10, 10, 10, 10]);
  const ev = addEvent(db, { season, course });
  saveResults(db, ev, [{ user_id: ids[0], stableford: 40 }, { user_id: ids[1], stableford: 38 }, { user_id: ids[2], stableford: 38 }, { user_id: ids[3], stableford: 30 }]);
  assert.deepEqual(ids.map((id) => res(db, ev, id).position), [1, 2, 2, 4]);
  saveResults(db, ev, [{ user_id: ids[0], stableford: 40 }, { user_id: ids[1], stableford: 38, position: 3 }, { user_id: ids[2], stableford: 38, position: 2 }, { user_id: ids[3], stableford: 30 }]);
  assert.deepEqual(ids.map((id) => res(db, ev, id).position), [1, 3, 2, 4]);
  const ev2 = addEvent(db, { season, course, title: 'Medal', date: '2026-06-06', format: 'medal', basis: 'stroke_net' });
  saveResults(db, ev2, [{ user_id: ids[0], gross: 80 }, { user_id: ids[1], gross: 78 }]);
  assert.equal(res(db, ev2, ids[1]).position, 1);
});

test('Order of Merit: scheme points, multiplier, bonus, best-N, tie-breaks, season isolation', () => {
  const { db, season, course, ids } = miniSociety([10, 10, 10]);
  db.prepare('UPDATE seasons SET scheme=? WHERE id=?').run(JSON.stringify({ positions: [10, 6, 3], participation: 1, bestN: 2 }), season);
  const evs = [1, 2, 3].map((i) => addEvent(db, { season, course, title: 'E' + i, date: `2026-0${i}-04`, mult: i === 3 ? 2 : 1 }));
  saveResults(db, evs[0], [{ user_id: ids[0], stableford: 40 }, { user_id: ids[1], stableford: 35 }, { user_id: ids[2], stableford: 30 }]);
  saveResults(db, evs[1], [{ user_id: ids[0], stableford: 31 }, { user_id: ids[1], stableford: 38, bonus: 2 }, { user_id: ids[2], stableford: 30 }]);
  saveResults(db, evs[2], [{ user_id: ids[2], stableford: 40 }, { user_id: ids[0], stableford: 20 }]);
  // points: e1: p0=11 p1=7 p2=4 ; e2: p1=11+2=13, p0=7, p2=4 ; e3 (x2): p2=21, p0 = 3+... pos2 => 6*2+1=13
  const om = standings.orderOfMerit(db, season);
  const by = Object.fromEntries(om.map((o) => [o.user_id, o]));
  assert.equal(res(db, evs[0], ids[0]).points, 11);
  assert.equal(res(db, evs[1], ids[1]).points, 13);
  assert.equal(res(db, evs[2], ids[2]).points, 21);
  assert.equal(res(db, evs[2], ids[0]).points, 13);
  // best 2 of 3: p0 = 13+11 = 24 ; p1 = 13+7 = 20 ; p2 = 21+4 = 25
  assert.equal(by[ids[0]].total, 24);
  assert.equal(by[ids[1]].total, 20);
  assert.equal(by[ids[2]].total, 25);
  assert.equal(by[ids[0]].dropped, 1);
  assert.equal(om[0].user_id, ids[2]);
  assert.equal(om[0].rank, 1);
  // other season is empty
  const s2 = db.prepare("INSERT INTO seasons(name,year,start_date,end_date) VALUES ('2027',2027,'2027-01-01','2027-12-31')").run().lastInsertRowid;
  assert.equal(standings.orderOfMerit(db, s2).length, 0);
});

test('changing a season scheme recalculates points', () => {
  const { db, season, course, ids } = miniSociety([10, 10]);
  const ev = addEvent(db, { season, course });
  saveResults(db, ev, [{ user_id: ids[0], stableford: 40 }, { user_id: ids[1], stableford: 30 }]);
  const before = res(db, ev, ids[0]).points;
  db.prepare('UPDATE seasons SET scheme=? WHERE id=?').run(JSON.stringify({ positions: [100, 50], participation: 0, bestN: null }), season);
  recomputeAll(db);
  assert.notEqual(res(db, ev, ids[0]).points, before);
  assert.equal(res(db, ev, ids[0]).points, 100);
  assert.equal(res(db, ev, ids[1]).points, 50);
});

test('roll of honour: event winners are automatic; Order of Merit champion on season close', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14]);
  const cat = db.prepare('SELECT id FROM honour_categories WHERE name=?').get("Captain's Day").id;
  const ev = addEvent(db, { season, course, cat, title: "Captain's Day" });
  saveResults(db, ev, [{ user_id: ids[0], stableford: 30 }, { user_id: ids[1], stableford: 41 }]);
  let h = db.prepare("SELECT * FROM honours WHERE source='auto'").all();
  assert.equal(h.length, 1);
  assert.equal(h[0].user_id, ids[1]);
  assert.equal(h[0].detail, '41 pts');
  assert.equal(h[0].year, 2026);
  db.prepare("UPDATE seasons SET status='closed' WHERE id=?").run(season);
  recomputeAll(db);
  h = db.prepare("SELECT h.*, c.name cat FROM honours h JOIN honour_categories c ON c.id=h.category_id WHERE source='auto' ORDER BY c.sort").all();
  assert.equal(h.length, 2);
  assert.equal(h[1].cat, 'Society Champion');
  assert.equal(h[1].user_id, ids[1]);
  // changing the winner re-flows the roll of honour
  saveResults(db, ev, [{ user_id: ids[0], stableford: 45 }, { user_id: ids[1], stableford: 41 }]);
  assert.equal(db.prepare("SELECT user_id FROM honours WHERE source='auto' AND event_id=?").get(ev).user_id, ids[0]);
  // reopening removes the OoM champion again
  db.prepare("UPDATE seasons SET status='open' WHERE id=?").run(season);
  recomputeAll(db);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM honours WHERE season_id=? AND event_id IS NULL").get(season).n, 0);
});

test('manual honours survive recomputation; foursomes pairs share a title', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14, 16]);
  const cat = db.prepare("SELECT id FROM honour_categories WHERE name='Winter Foursomes'").get().id;
  db.prepare("INSERT INTO honours(category_id,year,user_id,detail,source) VALUES (?,2019,?, '41 pts','manual')").run(cat, ids[0]);
  const ev = addEvent(db, { season, course, cat, format: 'foursomes', basis: 'manual', hcp: 0, title: 'Foursomes' });
  saveResults(db, ev, [{ user_id: ids[0], position: 2 }, { user_id: ids[1], position: 2 }, { user_id: ids[2], position: 1, note: '36 pts' }, { user_id: ids[3], position: 1, note: '36 pts' }]);
  const rows = db.prepare('SELECT * FROM honours ORDER BY year').all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].source, 'manual');
  assert.ok(rows[1].user_id && rows[1].partner_id);
  assert.deepEqual([rows[1].user_id, rows[1].partner_id].sort(), [ids[2], ids[3]].sort());
});

test('stats & records derive from the DB', () => {
  const { db, season, course, ids } = miniSociety([10, 12]);
  const e1 = addEvent(db, { season, course, title: 'One', date: '2026-03-07' });
  const e2 = addEvent(db, { season, course, title: 'Two', date: '2026-04-04' });
  saveResults(db, e1, [{ user_id: ids[0], gross: 80 }, { user_id: ids[1], gross: 90 }]);
  saveResults(db, e2, [{ user_id: ids[0], gross: 75 }, { user_id: ids[1], gross: 85 }]);
  const st = stats.playerStats(db, ids[0]);
  assert.equal(st.rounds, 2);
  assert.equal(st.wins, 2);
  assert.equal(st.bestGross, 75);
  assert.ok(st.avgStableford > 30);
  const recs = stats.records(db);
  const keys = recs.map((r) => r.key);
  assert.ok(keys.some((k) => k.startsWith('course-')));
  assert.equal(recs.find((r) => r.key.startsWith('course-')).value, '75');
  assert.ok(keys.includes('hi-stb') && keys.includes('low-net') && keys.includes('margin') && keys.includes('win-streak'));
  assert.equal(recs.find((r) => r.key === 'win-streak').value, '2 in a row');
  assert.throws(() => saveResults(db, e1, [{ user_id: ids[0], gross: 'abc' }]), /Invalid/);
  assert.throws(() => saveResults(db, e1, [{ user_id: ids[0], note: 'no score' }]), /needs a gross/);
});

test('highlights: waitlist sanity — results can be entered for any member including non-RSVPs', () => {
  const { db, season, course, ids } = miniSociety([10, 12]);
  const ev = addEvent(db, { season, course });
  saveResults(db, ev, [{ user_id: ids[1], stableford: 33 }]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM results WHERE event_id=?').get(ev).n, 1);
});
