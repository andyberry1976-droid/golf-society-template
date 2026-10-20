'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, getSettings, setSetting } = require('../src/db');
const { startApp, Client, miniSociety, addEvent, recomputeAll } = require('./helpers');
const { saveResults } = require('../src/lib/results');
const { setHandicapMode } = require('../src/lib/hcp-mode');
const D = require('../sites/demo/seed/demo-data.json');

const idxOf = (db, id) => db.prepare('SELECT handicap_index h FROM users WHERE id=?').get(id).h;

test('fixed module: results never change a handicap; playing handicap = handicap on every course', () => {
  const { db, season, course, ids } = miniSociety([9.4, 20.6, 15, 28]);
  setSetting(db, 'handicap_mode', 'fixed');
  const hard = db.prepare("INSERT INTO courses(name,tee,par,rating,slope) VALUES ('Hard','White',72,75.5,150)").run().lastInsertRowid;
  for (const [i, c] of [course, hard].entries()) {
    const ev = addEvent(db, { season, course: c, date: `2026-0${i + 4}-01`, status: 'completed' });
    saveResults(db, ev, ids.map((u, k) => ({ user_id: u, stableford: [45, 20, 36, 40][k] })));
  }
  recomputeAll(db);
  assert.deepEqual(ids.map((u) => idxOf(db, u)), [9.4, 20.6, 15, 28]);
  const rows = db.prepare('SELECT user_id, playing_handicap ph, course_handicap ch, differential d FROM results ORDER BY id').all();
  for (const r of rows) {
    const want = Math.round(idxOf(db, r.user_id));
    assert.equal(r.ph, want); assert.equal(r.ch, want); assert.equal(r.d, null);
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM handicap_history WHERE source IN ('event','extra')").get().n, 0);
});

test('fixed module: switching from automatic keeps every handicap and its history', () => {
  const { db, season, course, ids } = miniSociety([10, 15, 20, 25]);
  setSetting(db, 'handicap_mode', 'society');
  for (let i = 0; i < 3; i++) {
    const ev = addEvent(db, { season, course, date: `2026-0${i + 4}-01`, status: 'completed' });
    saveResults(db, ev, ids.map((u, k) => ({ user_id: u, stableford: 30 + k * 4 + i })));
  }
  recomputeAll(db);
  const before = ids.map((u) => idxOf(db, u));
  const hist = (u) => db.prepare('SELECT effective_on, index_after FROM handicap_history WHERE user_id=? ORDER BY seq').all(u);
  const hBefore = ids.map(hist);
  const res = db.prepare('SELECT id, idx_at_event, playing_handicap FROM results ORDER BY id').all();
  assert.notDeepEqual(before, [10, 15, 20, 25], 'society mode did adjust');
  const r = setHandicapMode(db, 'fixed', { actorId: ids[0] });
  assert.ok(r.frozen > 0);
  assert.deepEqual(ids.map((u) => idxOf(db, u)), before, 'current handicaps unchanged');
  assert.deepEqual(ids.map(hist), hBefore, 'history unchanged (dates and values)');
  assert.deepEqual(db.prepare('SELECT id, idx_at_event, playing_handicap FROM results ORDER BY id').all(), res, 'handicap at each event unchanged');
  assert.match(db.prepare("SELECT detail FROM audit_log WHERE action='set_handicap_mode'").get().detail, /society → fixed; \d+ automatic adjustments kept/);
  assert.deepEqual(setHandicapMode(db, 'fixed'), { changed: false, frozen: 0 }, 'idempotent');
  // a new result now changes nothing
  const ev = addEvent(db, { season, course, date: '2026-09-01', status: 'completed' });
  saveResults(db, ev, ids.map((u) => ({ user_id: u, stableford: 44 })));
  assert.deepEqual(ids.map((u) => idxOf(db, u)), before);
});

test('Demo (golden): fixed mode keeps the sheet handicaps and history; results no longer cut', () => {
  const db = open(':memory:');
  require('../scripts/seed-demo-site').seedDemo(db);
  assert.equal(getSettings(db).handicap_mode, 'fixed');
  for (const h of D.handicaps) assert.equal(db.prepare('SELECT handicap_index h FROM users WHERE name=?').get(h.name).h, h.actual, h.name);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM handicap_history h JOIN users u ON u.id=h.user_id WHERE u.status='active'").get().n, 71); // 2026 members (2025-only members are inactive)
  // a 45-point win at the next monthly (9+ players) would have cut under the old society maths; now nothing changes
  const ev = db.prepare("SELECT id FROM events WHERE status='scheduled' ORDER BY event_date LIMIT 1").get().id;
  const players = db.prepare("SELECT id FROM users ORDER BY id LIMIT 10").all().map((u) => u.id);
  const was = players.map((u) => idxOf(db, u));
  saveResults(db, ev, players.map((u, i) => ({ user_id: u, stableford: i ? 30 : 45 })));
  assert.deepEqual(players.map((u) => idxOf(db, u)), was);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM handicap_history h JOIN users u ON u.id=h.user_id WHERE u.status='active'").get().n, 71); // 2026 members (2025-only members are inactive)
});

test('Demo UI: no slope/rating/WHS wording; admin sets a handicap -> history + audit', async () => {
  const db = open(':memory:');
  require('../scripts/seed-demo-site').seedDemo(db);
  const app = await startApp(db);
  try {
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    const done = db.prepare("SELECT id FROM events WHERE status='completed' ORDER BY event_date LIMIT 1").get().id;
    const ben = db.prepare("SELECT id FROM users WHERE name='Player 1'").get().id;
    const pages = ['/admin/courses', `/events/${done}`, `/admin/events/${done}/results`, `/admin/events/${done}/edit`, '/admin/events/new', `/admin/members/${ben}`, '/admin/settings', `/players/${ben}`, '/rules'];
    for (const p of pages) {
      const r = await adm.get(p);
      assert.equal(r.status, 200, p);
      const text = r.text_.replace(/<[^>]+>/g, ' ');
      assert.doesNotMatch(text, /\bslope\b|course rating|\bWHS\b|differential|allowance|general-play|buffer/i, p);
    }
    assert.doesNotMatch((await adm.get('/admin/settings')).text_, /name="handicap_mode"[^>]*<option/, 'locked: no module dropdown');
    const before = idxOf(db, ben);
    const r = await adm.post(`/admin/members/${ben}/handicap`, { index: '4.0', note: 'Cut by committee' });
    assert.equal(r.status, 302);
    assert.equal(idxOf(db, ben), 4);
    const h = db.prepare('SELECT * FROM handicap_history WHERE user_id=? ORDER BY seq DESC LIMIT 1').get(ben);
    assert.equal(h.index_after, 4); assert.equal(h.index_before, before); assert.equal(h.label, 'Cut by committee');
    assert.match(db.prepare("SELECT detail FROM audit_log WHERE action='set_handicap' ORDER BY id DESC").get().detail, new RegExp(`${before} -> 4 \\(Cut by committee\\)`));
    // general-play rounds are refused
    await adm.post(`/admin/members/${ben}/extra-round`, { played_on: '2026-06-01', course_name: 'X', ags: '80', rating: '72', slope: '113', par: '72' });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM extra_rounds').get().n, 0);
    // editing a course keeps its stored rating/slope
    const c = db.prepare('SELECT * FROM courses LIMIT 1').get();
    assert.equal((await adm.post(`/admin/courses/${c.id}`, { name: c.name, tee: c.tee, par: '71', rating: String(c.rating), slope: String(c.slope), location: '' })).status, 302);
    assert.equal(db.prepare('SELECT par FROM courses WHERE id=?').get(c.id).par, 71);
  } finally { await app.close(); }
});
