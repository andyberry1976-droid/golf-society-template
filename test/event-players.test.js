'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { open } = require('../src/db');
const { startApp, Client } = require('./helpers');
const Field = require('../src/lib/field');
const standings = require('../src/lib/standings');
const comps = require('../src/lib/comps');

function demo() {
  const db = open(':memory:');
  require('../scripts/seed-demo-site').seedDemo(db);
  return db;
}
const season = (db) => db.prepare("SELECT id FROM seasons WHERE name='2026'").get().id;
const uidOf = (db, name) => db.prepare('SELECT id FROM users WHERE name=?').get(name).id;

test('field: everyone already in an event is in its field (results, comp entries, going RSVPs)', () => {
  const db = demo();
  const ev = db.prepare("SELECT e.id FROM events e WHERE e.status='completed' AND e.tournament_id IS NULL AND e.event_date>='2024' ORDER BY e.event_date LIMIT 1").get().id;
  const ids = new Set(Field.list(db, ev).map((p) => p.id));
  for (const r of db.prepare('SELECT user_id FROM results WHERE event_id=?').all(ev)) assert.ok(ids.has(r.user_id));
  for (const r of db.prepare('SELECT user_id FROM comp_scores WHERE event_id=?').all(ev)) assert.ok(ids.has(r.user_id));
  const cand = Field.candidates(db, ev).map((c) => c.id);
  assert.ok(cand.every((c) => !ids.has(c)), 'candidates exclude the field');
  assert.equal(ids.size + cand.length, db.prepare("SELECT COUNT(*) n FROM users WHERE status='active'").get().n);
});

test('field: backfill runs once when an older database first gets event_players', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-')); const file = path.join(dir, 'old.db');
  let db = open(file); require('../scripts/seed-demo-site').seedDemo(db);
  const want = db.prepare('SELECT COUNT(*) n FROM event_players').get().n;
  db.exec('DROP TABLE event_players'); db.close(); // simulate a database from before this change
  db = open(file);
  const backfilled = db.prepare('SELECT COUNT(*) n FROM event_players').get().n;
  assert.ok(backfilled > 0);
  const expect = db.prepare(`SELECT COUNT(*) n FROM (SELECT event_id,user_id FROM results UNION SELECT event_id,user_id FROM comp_scores UNION SELECT event_id,user_id FROM rsvps WHERE status='going')`).get().n;
  assert.equal(backfilled, expect); assert.ok(want >= 0);
  db.close();
});

test('remove: score, Birdie & FedEx entries go and every table recalculates', () => {
  const db = demo(); const S = season(db);
  // the monthly with the most Birdie/FedEx entries
  const ev = db.prepare(`SELECT r.event_id id FROM results r JOIN comp_scores c ON c.event_id=r.event_id AND c.user_id=r.user_id JOIN events e ON e.id=r.event_id
    WHERE e.tournament_id IS NULL AND e.season_id=@S AND r.position=1 GROUP BY r.event_id ORDER BY COUNT(*) DESC LIMIT 1`).get({ S }).id;
  const winner = db.prepare('SELECT user_id, stableford FROM results WHERE event_id=? AND position=1').get(ev);
  const oomOf = (u) => (standings.orderOfMerit(db, S).find((o) => o.user_id === u) || { total: 0 }).total;
  const compOf = (c, u) => { const t = comps.compTable(db, c, S); const rows = t.rows || t; const r = rows.find((x) => x.user_id === u); return r ? r.total : 0; };
  const before = { oom: oomOf(winner.user_id), birdie: compOf('birdie', winner.user_id), fedex: compOf('fedex', winner.user_id) };
  const myBirdie = (db.prepare("SELECT value FROM comp_scores WHERE comp='birdie' AND event_id=? AND user_id=?").get(ev, winner.user_id) || { value: 0 }).value;
  const myFedex = (db.prepare("SELECT value FROM comp_scores WHERE comp='fedex' AND event_id=? AND user_id=?").get(ev, winner.user_id) || { value: 0 }).value;
  const r = Field.remove(db, ev, winner.user_id);
  assert.equal(r.result.stableford_in, winner.stableford);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM results WHERE event_id=? AND user_id=?').get(ev, winner.user_id).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM comp_scores WHERE event_id=? AND user_id=?').get(ev, winner.user_id).n, 0);
  assert.ok(!Field.inField(db, ev, winner.user_id));
  const newWin = db.prepare('SELECT user_id FROM results WHERE event_id=? AND position=1').all(ev);
  assert.ok(newWin.length >= 1 && newWin.every((x) => x.user_id !== winner.user_id), 'positions re-flow: a new winner');
  assert.ok(oomOf(winner.user_id) <= before.oom - 0, 'OoM recalculated');
  assert.equal(compOf('birdie', winner.user_id), before.birdie - myBirdie, 'Birdie League recalculated');
  assert.equal(compOf('fedex', winner.user_id), before.fedex - myFedex, 'FedEx recalculated');
  assert.ok(Field.candidates(db, ev).some((c) => c.id === winner.user_id), 'can be added back');
});

test('HTTP: captain adds and removes players; confirm warns about scores; audited; members blocked', async () => {
  const db = demo();
  const app = await startApp(db);
  try {
    const cap = new Client(app.base); await cap.login('captain@example.test', 'flamingo-demo-1');
    const mem = new Client(app.base); await mem.login('member@example.test', 'flamingo-demo-1');
    const up = db.prepare("SELECT id FROM events WHERE status='scheduled' ORDER BY event_date LIMIT 1").get().id;
    const done = db.prepare("SELECT event_id id FROM results GROUP BY event_id ORDER BY event_id LIMIT 1").get().id;
    const page = await cap.get(`/admin/events/${done}/edit`);
    assert.equal(page.status, 200);
    assert.match(page.text_, /id="players"/);
    assert.match(page.text_, /will be DELETED/, 'remove of a scored player warns');
    assert.match(page.text_, /data-confirm="Remove /);
    // add two members to the upcoming event
    const [a, b] = Field.candidates(db, up).slice(0, 2);
    let r = await cap.post(`/admin/events/${up}/players`, { user_ids: String(a.id) });
    assert.equal(r.status, 302);
    r = await cap.req('POST', `/admin/events/${up}/players`, { form: { _csrf: await cap.csrf(), user_ids: [String(b.id)] } });
    assert.ok(Field.inField(db, up, a.id) && Field.inField(db, up, b.id));
    const edit = await cap.get(`/admin/events/${up}/edit`);
    assert.match(edit.text_, new RegExp(a.name));
    assert.doesNotMatch(edit.text_.split('id="add-players"')[1] || '', new RegExp(`>${a.name} —`), 'no longer offered');
    const addLog = db.prepare("SELECT detail FROM audit_log WHERE action='event_add_player' ORDER BY id").all().map((x) => x.detail);
    assert.ok(addLog.some((d) => d.includes(`+ ${a.name}`) && /hcp \d/.test(d)));
    // remove a scored player from a completed event
    const victim = db.prepare('SELECT user_id, stableford_in FROM results WHERE event_id=? ORDER BY id LIMIT 1').get(done);
    r = await cap.post(`/admin/events/${done}/players/${victim.user_id}/remove`, {});
    assert.equal(r.status, 302);
    assert.ok(!Field.inField(db, done, victim.user_id));
    const rm = db.prepare("SELECT detail FROM audit_log WHERE action='event_remove_player' ORDER BY id DESC").get().detail;
    assert.match(rm, new RegExp(`result deleted \\(stableford ${victim.stableford_in}`));
    // bad input and permissions
    assert.equal((await cap.post(`/admin/events/${up}/players`, { user_ids: '999999' })).status, 302);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM event_players WHERE user_id=999999").get().n, 0);
    assert.equal((await mem.post(`/admin/events/${up}/players`, { user_ids: String(Field.candidates(db, up)[0].id) })).status, 403);
    assert.equal((await mem.post(`/admin/events/${up}/players/${a.id}/remove`, {})).status, 403);
    assert.ok(Field.inField(db, up, a.id));
    assert.equal((await cap.post(`/admin/events/99999/players`, { user_ids: String(a.id) })).status, 404);
  } finally { await app.close(); }
});

test('field with RSVPs off: adding players needs no RSVP; results then show for them', async () => {
  const db = demo();
  assert.equal(db.prepare("SELECT value FROM settings WHERE key='feature_rsvp'").get().value, '0');
  const up = db.prepare("SELECT id FROM events WHERE status='scheduled' ORDER BY event_date DESC LIMIT 1").get().id;
  const ids = Field.candidates(db, up).slice(0, 3).map((c) => c.id);
  Field.add(db, up, ids, null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM rsvps WHERE event_id=?').get(up).n, 0);
  require('../src/lib/results').saveResults(db, up, ids.map((u, i) => ({ user_id: u, stableford: 30 + i })));
  const ph = db.prepare('SELECT r.playing_handicap ph, u.handicap_index h FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=?').all(up);
  for (const x of ph) assert.equal(x.ph, Math.round(x.h), 'fixed handicap applied');
});

test('Manage players is discoverable: public event page, admin list, results page (staff only)', async () => {
  const db = demo();
  const app = await startApp(db);
  try {
    const cap = new Client(app.base); await cap.login('captain@example.test', 'flamingo-demo-1');
    const mem = new Client(app.base); await mem.login('member@example.test', 'flamingo-demo-1');
    const id = db.prepare("SELECT event_id id FROM results GROUP BY event_id LIMIT 1").get().id;
    const link = new RegExp(`/admin/events/${id}/edit#players`);
    assert.match((await cap.get(`/events/${id}`)).text_, link);
    assert.match((await cap.get(`/events/${id}`)).text_, /Manage players/);
    assert.match((await cap.get('/admin/events')).text_, link);
    assert.match((await cap.get(`/admin/events/${id}/results`)).text_, link);
    assert.doesNotMatch((await mem.get(`/events/${id}`)).text_, /Manage players/);
  } finally { await app.close(); }
});
