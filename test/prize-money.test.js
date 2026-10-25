'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, setSetting, getSettings } = require('../src/db');
const users = require('../src/lib/users');
const PZ = require('../src/lib/prizes');
const { startApp, Client, miniSociety } = require('./helpers');

function site() {
  const { db, season } = miniSociety(); setSetting(db, 'prize_start_season', '2027');
  const mk = (name, email, role) => { const id = users.createUser(db, { name, email, passwordHash: users.hashPassword('password-123'), index: 18, joinedOn: '2025-01-01' }); db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id); return id; };
  const ids = { admin: mk('Prize Admin', 'pz-admin@t.example', 'admin'), cap: mk('Prize Captain', 'pz-cap@t.example', 'captain'), mem: mk('Prize Member', 'pz-mem@t.example', 'member'), a: mk('Player 64', 'pz-a@t.example', 'member'), b: mk('Player 65', 'pz-b@t.example', 'member') };
  const s27 = db.prepare("INSERT INTO seasons(name,year,start_date,end_date) VALUES ('2027',2027,'2027-01-01','2027-12-31')").run().lastInsertRowid;
  const s28 = db.prepare("INSERT INTO seasons(name,year,start_date,end_date) VALUES ('2028',2028,'2028-01-01','2028-12-31')").run().lastInsertRowid;
  const ev = (season, title, date, end = null) => db.prepare('INSERT INTO events(season_id,title,event_date,end_date) VALUES (?,?,?,?)').run(season, title, date, end).lastInsertRowid;
  const e1 = ev(s27, 'Spring Swing', '2027-04-10'); const e2 = ev(s27, 'Algarve Tour', '2027-06-11', '2027-06-13'); const e3 = ev(s28, 'Opener 2028', '2028-04-08');
  const old = ev(season, 'Last year', '2026-05-02');
  return { db, ids, e1, e2, e3, old };
}
const snapshot = (db) => JSON.stringify(['results', 'events', 'users', 'fantasy_teams', 'fantasy_pool', 'season_handicaps'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()));

test('amounts: positive, up to 2 decimal places; currency symbol and commas allowed', () => {
  assert.equal(PZ.parseAmount('25'), 2500); assert.equal(PZ.parseAmount('12.5'), 1250); assert.equal(PZ.parseAmount('12.50'), 1250);
  assert.equal(PZ.parseAmount('£1,000.05'), 100005); assert.equal(PZ.parseAmount(' 0.01 '), 1); assert.equal(PZ.parseAmount('€7', '€'), 700);
  for (const bad of ['', '0', '0.00', '-5', '12.345', 'ten', '1e3', '5.', '.5', '£', null, '99999999']) assert.equal(PZ.parseAmount(bad), null, String(bad));
  assert.equal(PZ.fmtMoney(2500), '£25'); assert.equal(PZ.fmtMoney(1250), '£12.50'); assert.equal(PZ.fmtMoney(123456, '$'), '$1,234.56');
  assert.deepEqual(PZ.split(1000, 3), [334, 333, 333]); assert.deepEqual(PZ.split(1000, 2), [500, 500]);
});

test('start season: setting, blank = this year; years never go below it', () => {
  const { db } = site();
  assert.equal(PZ.startSeason({ prize_start_season: '2027' }), 2027);
  assert.equal(PZ.startSeason({ prize_start_season: '' }), PZ.thisYear());
  assert.equal(PZ.startSeason({}), PZ.thisYear());
  const S = { prize_start_season: '2027' };
  const ys = PZ.years(db, S); assert.equal(Math.min(...ys), 2027); assert.ok(ys.includes(2028));
  assert.equal(PZ.pickYear(db, S, '2025'), PZ.pickYear(db, S, ''), 'an earlier year is never shown');
  assert.equal(PZ.pickYear(db, S, '2028'), 2028);
  assert.equal(getSettings(open(':memory:')).prize_start_season, '', 'template default: blank = the current year');
  assert.deepEqual(PZ.years(open(':memory:'), { prize_start_season: '' }).slice(-1), [PZ.thisYear()]);
});

test('prize money: admin-only entry, validation, ties and splits, totals, leaderboard, year filter, audit', async () => {
  const { db, ids, e1, e2, e3, old } = site();
  db.prepare('INSERT INTO results(event_id,user_id,position) VALUES (?,?,1),(?,?,2)').run(e1, ids.a, e1, ids.b);
  const before = snapshot(db);
  const app = await startApp(db);
  try {
    const anon = new Client(app.base); const mem = new Client(app.base); const cap = new Client(app.base); const adm = new Client(app.base);
    await mem.login('pz-mem@t.example'); await cap.login('pz-cap@t.example'); await adm.login('pz-admin@t.example');
    // public page with nothing yet; in the Results menu
    let r = await anon.get('/prize-money'); assert.equal(r.status, 200); assert.match(r.text_, /No prize money yet/); assert.match(r.text_, /href="\/prize-money"/);
    // admin only: anon redirected to login, member and captain 403 (GET and POST)
    assert.equal((await anon.get('/admin/prizes')).status, 302);
    assert.equal((await mem.get('/admin/prizes')).status, 403); assert.equal((await cap.get('/admin/prizes')).status, 403);
    assert.equal((await cap.get(`/admin/prizes/events/${e1}`)).status, 403);
    assert.equal((await mem.post(`/admin/prizes/events/${e1}/lines`, { kind: 'ntp', amount: '10', user_id: String(ids.mem) })).status, 403);
    assert.equal((await cap.post(`/admin/prizes/events/${e1}/lines`, { kind: 'ntp', amount: '10', user_id: String(ids.cap) })).status, 403);
    // CSRF required
    r = await adm.req('POST', `/admin/prizes/events/${e1}/lines`, { form: { kind: 'ntp', amount: '10', winner_name: 'X' } }); assert.equal(r.status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM prize_lines').get().n, 0);
    // admin pages; winner suggested from results (1st = Alf)
    r = await adm.get('/admin/prizes'); assert.equal(r.status, 200); assert.match(r.text_, /Spring Swing/); assert.match(r.text_, /Algarve Tour/); assert.doesNotMatch(r.text_, /Opener 2028/);
    r = await adm.get(`/admin/prizes/events/${e1}`); assert.equal(r.status, 200); assert.match(r.text_, /From the results: 1st Player 64 · 2nd Player 65/);
    assert.match(r.text_, new RegExp(`id="pz-ap-u0" name="w_user">.*?<option value="${ids.a}" selected>`, 's'));
    // validation
    for (const amount of ['0', '-3', '12.345', 'lots', '']) { r = await adm.post(`/admin/prizes/events/${e1}/lines`, { kind: 'place', position: '1', amount, w_user: String(ids.a) }); assert.equal(r.status, 422, amount); assert.match(r.text_, /positive number with up to 2 decimal places/); }
    r = await adm.post(`/admin/prizes/events/${e1}/lines`, { kind: 'place', position: '0', amount: '5', w_user: String(ids.a) }); assert.equal(r.status, 422); assert.match(r.text_, /Position must be a whole number/);
    r = await adm.post(`/admin/prizes/events/${e1}/lines`, { kind: 'place', position: '1', amount: '5' }); assert.equal(r.status, 422); assert.match(r.text_, /Pick a member or type the winner/);
    r = await adm.post(`/admin/prizes/events/${e1}/lines`, { kind: 'other', amount: '5', winner_name: 'Someone' }); assert.equal(r.status, 422); assert.match(r.text_, /Say what the prize is for/);
    r = await adm.post(`/admin/prizes/events/${e1}/lines`, { kind: 'bogus', amount: '5', winner_name: 'Someone' }); assert.equal(r.status, 422);
    r = await adm.post(`/admin/prizes/events/${e1}/lines`, { kind: 'ntp', amount: '5', user_id: '999999' }); assert.equal(r.status, 422);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM prize_lines').get().n, 0, 'nothing saved by bad forms');
    // seasons before the start season are refused
    r = await adm.post(`/admin/prizes/events/${old}/lines`, { kind: 'ntp', amount: '5', winner_name: 'Player 95' }); assert.equal(r.status, 422); assert.match(r.text_, /starts with the 2027 season/);
    // e1: 1st £40 Alf, tied 2nd £30 split Bob + typed guest, NTP 7th £10 Alf, NTP (no hole) £5 Bob, longest drive £7.50 guest
    const add = (ev, form) => adm.post(`/admin/prizes/events/${ev}/lines`, form);
    assert.equal((await add(e1, { kind: 'place', position: '1', amount: '40', w_user: String(ids.a), w_name: '', split: '1' })).status, 302);
    const tie = new URLSearchParams({ _csrf: await adm.csrf(), kind: 'place', position: '2', amount: '30.01', split: '1' }); for (const u of [String(ids.b), '', '']) tie.append('w_user', u); for (const n of ['', 'Player 63', '']) tie.append('w_name', n);
    assert.equal((await adm.req('POST', `/admin/prizes/events/${e1}/lines`, { form: tie })).status, 302);
    assert.deepEqual(db.prepare("SELECT amount_pence a, winner_name w FROM prize_lines WHERE event_id=? AND position=2 ORDER BY id").all(e1), [{ a: 1501, w: 'Player 65' }, { a: 1500, w: 'Player 63' }]);
    assert.equal((await add(e1, { kind: 'ntp', label: '7th', amount: '10', user_id: String(ids.a) })).status, 302);
    assert.equal((await add(e1, { kind: 'ntp', amount: '5', user_id: String(ids.b) })).status, 302);
    assert.equal((await add(e1, { kind: 'other', label: 'Longest drive', amount: '7.50', winner_name: 'player 63' })).status, 302);
    // e2: tie for 1st without split = each gets the full amount; NTP Alf
    const tie2 = new URLSearchParams({ _csrf: await adm.csrf(), kind: 'place', position: '1', amount: '20' }); for (const u of [String(ids.a), String(ids.b)]) tie2.append('w_user', u); tie2.append('w_name', ''); tie2.append('w_name', '');
    assert.equal((await adm.req('POST', `/admin/prizes/events/${e2}/lines`, { form: tie2 })).status, 302);
    assert.equal(db.prepare('SELECT SUM(amount_pence) s FROM prize_lines WHERE event_id=?').get(e2).s, 4000);
    // 2028 event is in its own year
    assert.equal((await add(e3, { kind: 'place', position: '1', amount: '100', user_id: String(ids.mem), w_user: String(ids.mem) })).status, 302);
    // totals, leaderboard and ties (2027): Alf 40+10+20=70 (3), Bob 15.01+5+20=40.01 (3), Gary 15+7.50=22.50 (2)
    const P = PZ.season(db, 2027);
    assert.equal(P.total, 4000 + 3001 + 1000 + 500 + 750 + 4000); assert.equal(P.prizes, 8);
    assert.deepEqual(P.board.map((p) => [p.name, p.total, p.count, p.pos]), [['Player 64', 7000, 3, 1], ['Player 65', 4001, 3, 2], ['Player 63', 2250, 2, 3]]);
    assert.deepEqual(P.events.map((e) => e.total), [9251, 4000]);
    const l1 = PZ.eventLines(db, e1).map((l) => l.title); assert.deepEqual(l1, ['1st', '=2nd', '=2nd', 'Nearest the pin', 'Nearest the pin (7th)', 'Longest drive']);
    // public page: per-event breakdown, leaderboard, grand total; mobile sticky name column
    r = await anon.get('/prize-money?year=2027'); assert.equal(r.status, 200);
    assert.match(r.text_, /Total paid out in 2027/); assert.match(r.text_, /<p class="pz-big">£132.51<\/p>/);
    assert.match(r.text_, /<details class="pz-ev" id="pz-e\d+"[^>]*>\s*<summary><span class="pz-et"><strong>Spring Swing<\/strong>/); assert.match(r.text_, /11–13 Jun 2027/);
    assert.match(r.text_, /=2nd<\/th><td class="l"><a href="\/players\/\d+">Player 65<\/a><\/td><td>£15.01<\/td>/);
    assert.match(r.text_, /Event total<\/th><td><\/td><td class="tot">£92.51<\/td>/);
    assert.match(r.text_, /<th class="st" scope="row"><a href="\/players\/\d+">Player 64<\/a><\/th><td>3<\/td><td class="tot">£70<\/td>/);
    assert.doesNotMatch(r.text_, /Opener 2028/);
    // year filter: 2028 separate; earlier years never shown even if asked for
    r = await anon.get('/prize-money?year=2028'); assert.match(r.text_, /Opener 2028/); assert.match(r.text_, /£100/); assert.doesNotMatch(r.text_, /Spring Swing/);
    r = await anon.get('/prize-money?year=2026'); assert.doesNotMatch(r.text_, /<option value="2026"/); assert.doesNotMatch(r.text_, /Prize Money 2026/);
    assert.match(r.text_, /<option value="2027"/);
    // edit and delete
    const ntp = db.prepare("SELECT id FROM prize_lines WHERE label='7th'").get().id;
    r = await adm.post(`/admin/prizes/lines/${ntp}`, { label: '17th', amount: '12.345', user_id: String(ids.a) }); assert.equal(r.status, 422); assert.match(r.text_, /positive number/);
    r = await adm.post(`/admin/prizes/lines/${ntp}`, { label: '17th', amount: '12', user_id: '', winner_name: 'Player 63' }); assert.equal(r.status, 302);
    assert.deepEqual(db.prepare('SELECT label, amount_pence, user_id, winner_name FROM prize_lines WHERE id=?').get(ntp), { label: '17th', amount_pence: 1200, user_id: null, winner_name: 'Player 63' });
    assert.equal((await cap.post(`/admin/prizes/lines/${ntp}/delete`)).status, 403);
    r = await adm.post(`/admin/prizes/lines/${ntp}/delete`); assert.equal(r.status, 302); assert.equal(PZ.getLine(db, ntp), undefined);
    assert.equal((await adm.post('/admin/prizes/lines/999999/delete')).status, 404);
    // audit log
    const acts = db.prepare("SELECT action, COUNT(*) n FROM audit_log WHERE action LIKE 'prize_%' GROUP BY action").all().reduce((o, x) => ({ ...o, [x.action]: x.n }), {});
    assert.deepEqual(acts, { prize_add: 9, prize_edit: 1, prize_delete: 1 });
    assert.match(db.prepare("SELECT detail FROM audit_log WHERE action='prize_edit'").get().detail, /was nearest the pin 7th: £10 to Player 64; now nearest the pin 17th: £12 to Player 63/);
    // start season setting
    assert.equal((await adm.post('/admin/prizes/settings', { prize_start_season: 'soon' })).status, 302); assert.equal(getSettings(db).prize_start_season, '2027');
    assert.equal((await adm.post('/admin/prizes/settings', { prize_start_season: '2028' })).status, 302); assert.equal(getSettings(db).prize_start_season, '2028');
    r = await anon.get('/prize-money'); assert.doesNotMatch(r.text_, /<option value="2027"/);
    // results, events, members, fantasy untouched
    assert.equal(snapshot(db), before);
    // feature switch off: 404 and gone from the menu
    setSetting(db, 'feature_prizes', '0');
    assert.equal((await anon.get('/prize-money')).status, 404); assert.equal((await adm.get('/admin/prizes')).status, 404);
    assert.doesNotMatch((await anon.get('/')).text_, /href="\/prize-money"/);
    // generic currency
    setSetting(db, 'feature_prizes', '1'); setSetting(db, 'prize_start_season', '2027'); setSetting(db, 'currency', '€');
    r = await anon.get('/prize-money?year=2027'); assert.match(r.text_, /<p class="pz-big">€\d/);
  } finally { await app.close(); }
});
