'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setSetting, getSettings } = require('../src/db');
const users = require('../src/lib/users');
const FA = require('../src/lib/fantasy-admin');
const FL = require('../src/lib/fantasy');
const { startApp, Client, seedDemoPlusEvents } = require('./helpers');

// the same prices the Fantasy League page uses: generated from the latest season with completed events
function prices(db) {
  const { R, places } = FL.rulesFrom(getSettings(db));
  const y = db.prepare("SELECT MAX(s.year) y FROM seasons s JOIN events e ON e.season_id=s.id WHERE e.status='completed'").get().y;
  return { R, P: FL.livePrices(db, y, { R, places }) };
}

async function setup() {
  const { db } = seedDemoPlusEvents(); setSetting(db, 'feature_fantasy', '1');
  const mk = (name, email, role, username) => {
    const id = users.createUser(db, { name, email, passwordHash: users.hashPassword('password-123'), index: 18, joinedOn: '2025-01-01' });
    db.prepare('UPDATE users SET role=?, username=? WHERE id=?').run(role, username, id); return id;
  };
  const ids = { admin: mk('Player Admin', 'pa@t.example', 'admin', null), a: mk('Player One', 'p1@t.example', 'member', 'player1'), b: mk('Player Two', 'p2@t.example', 'member', 'player2') };
  db.prepare("INSERT INTO fantasy_teams(season,manager_name,team_name,user_id,picks,captain) VALUES (2026,'Player One','Old Team',?,?,?)").run(ids.a, JSON.stringify([{ name: 'X', user_id: null, price: 5 }]), 'X');
  const old = JSON.stringify(db.prepare('SELECT * FROM fantasy_teams WHERE season<=2026 ORDER BY id').all());
  const { R, P } = prices(db);
  assert.equal(P.season, FL.MEMBER_TEAM_SEASON);
  const byPrice = FA.pool(db, P.season, P).slice().sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
  const app = await startApp(db);
  const login = async (who) => { const c = new Client(app.base); assert.equal((await c.login(who)).status, 302, who); return c; };
  return { db, ids, app, old, login, close: app.close, R, P, cheap: (n, skip = 0) => byPrice.slice(skip, skip + n).map((p) => p.name), dear: (n) => byPrice.slice(-n).map((p) => p.name), byPrice };
}
const tok = async (c, p) => { const r = await c.get(p); const m = r.text_.match(/name="_csrf" value="([^"]+)"/); assert.ok(m, 'csrf on ' + p); return m[1]; };
const pairs = (o) => Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]]));
const post = (c, path, form) => c.req('POST', path, { form: pairs(form) });
const save = async (c, form) => post(c, '/fantasy-league/my-team', { _csrf: await tok(c, '/fantasy-league'), ...form });
const mine = (db, uid) => db.prepare('SELECT * FROM fantasy_teams WHERE season=2027 AND user_id=?').all(uid);
const old = (db) => JSON.stringify(db.prepare('SELECT * FROM fantasy_teams WHERE season<=2026 ORDER BY id').all());

test('anonymous visitors cannot open or post the member team page', async (t) => {
  const s = await setup(); t.after(s.close);
  const anon = new Client(s.app.base);
  const g = await anon.get('/fantasy-league/my-team');
  assert.equal(g.status, 302); assert.match(g.headers.get('location'), /^\/login\?next=/);
  const p = await post(anon, '/fantasy-league/my-team', { _csrf: await tok(anon, '/login'), team_name: 'Sneaky', picks: s.cheap(5), captain: s.cheap(1)[0] });
  assert.equal(p.status, 302); assert.match(p.headers.get('location'), /^\/login/);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM fantasy_teams WHERE season=2027').get().n, 0);
});

test('member creates ONE team linked to their profile, then edits it; older seasons untouched', async (t) => {
  const s = await setup(); t.after(s.close);
  const c = await s.login('player1');
  assert.match((await c.get('/fantasy-league')).text_, /Pick my team/);
  assert.equal((await c.get('/fantasy-league/my-team')).status, 200);
  const five = s.cheap(5);
  assert.equal((await save(c, { team_name: 'Fairway Five', picks: five, captain: five[2] })).status, 302);
  let rows = mine(s.db, s.ids.a); assert.equal(rows.length, 1);
  assert.equal(rows[0].manager_name, 'Player One'); assert.equal(rows[0].captain, five[2]); assert.equal(rows[0].created_by, s.ids.a);
  const five2 = [...five.slice(0, 4), s.cheap(1, 5)[0]];
  assert.equal((await save(c, { team_name: 'Fairway Five II', picks: five2, captain: five2[4] })).status, 302);
  rows = mine(s.db, s.ids.a); assert.equal(rows.length, 1); assert.equal(rows[0].team_name, 'Fairway Five II'); assert.equal(rows[0].captain, five2[4]);
  assert.match((await c.get('/fantasy-league')).text_, /Change my team/);
  assert.equal(old(s.db), s.old);
});

test('rules are the existing Fantasy League rules (same validation as admin-entered teams)', async (t) => {
  const s = await setup(); t.after(s.close);
  const c = await s.login('player1');
  const cases = [
    { team_name: 'Four Only', picks: s.cheap(4), captain: s.cheap(1)[0] },
    { team_name: 'No Skipper', picks: s.cheap(5), captain: '' },
    { team_name: 'Wrong Skipper', picks: s.cheap(5), captain: s.cheap(1, 6)[0] },
    { team_name: 'Ghosts', picks: [...s.cheap(4), 'Not A Golfer'], captain: s.cheap(1)[0] },
    { team_name: 'Twice', picks: [...s.cheap(4), s.cheap(1)[0]], captain: s.cheap(1)[0] },
    { team_name: 'X', picks: s.cheap(5), captain: s.cheap(1)[0] },
  ];
  if (s.byPrice.slice(-5).reduce((a, p) => a + p.price, 0) > s.R.budget) cases.push({ team_name: 'Big Spenders', picks: s.dear(5), captain: s.dear(1)[0] });
  for (const f of cases) {
    const r = await save(c, f);
    assert.equal(r.status, 422, f.team_name);
    const want = FA.checkTeam(s.db, 2027, { user_id: String(s.ids.a), ...f }, s.P, s.R, { requireMember: true });
    for (const msg of Object.values(want.errors)) assert.ok(r.text_.includes(msg.replace(/&/g, '&amp;')), `${f.team_name}: shows "${msg}"`);
  }
  assert.equal(mine(s.db, s.ids.a).length, 0);
});

test('members can only edit their own team; admin pages stay closed; admin tools still work', async (t) => {
  const s = await setup(); t.after(s.close);
  const a = await s.login('player1'); const b = await s.login('player2');
  const fa = s.cheap(5); await save(a, { team_name: 'Team A', picks: fa, captain: fa[0] });
  const teamA = mine(s.db, s.ids.a)[0]; const before = JSON.stringify(teamA);
  const fb = s.cheap(5, 1);
  assert.equal((await post(b, '/fantasy-league/my-team', { _csrf: await tok(b, '/fantasy-league'), team_name: 'Team B', picks: fb, captain: fb[0], user_id: String(s.ids.a) })).status, 302); // user_id in the body is ignored
  assert.equal(mine(s.db, s.ids.b).length, 1); assert.equal(JSON.stringify(mine(s.db, s.ids.a)[0]), before);
  const tk = await tok(b, '/fantasy-league');
  assert.equal((await post(b, `/fantasy-league/admin/teams/${teamA.id}/delete`, { _csrf: tk })).status, 403);
  assert.equal((await post(b, '/fantasy-league/admin/teams', { _csrf: tk, user_id: String(s.ids.a), team_name: 'Hijack', picks: fb, captain: fb[0] })).status, 403);
  for (const p of ['/admin', '/admin/members']) assert.equal((await b.get(p)).status, 403, p);
  assert.equal(JSON.stringify(mine(s.db, s.ids.a)[0]), before, 'A unchanged');
  // the admin can still remove a team with the existing tool
  const adm = await s.login('pa@t.example');
  assert.equal((await post(adm, `/fantasy-league/admin/teams/${teamA.id}/delete`, { _csrf: await tok(adm, '/fantasy-league') })).status, 302);
  assert.equal(mine(s.db, s.ids.a).length, 0);
  assert.equal(old(s.db), s.old);
});

// ---- the member lock: first tee time of the season's earliest event (London time), read from the calendar ----
const LOCK = require('../src/lib/fantasy-lock');
const season2027 = (db) => db.prepare("INSERT INTO seasons(name,year,start_date,end_date) VALUES ('2027',2027,'2027-01-01','2027-12-31')").run().lastInsertRowid;
const ev = (db, sid, date, tee, status = 'scheduled', title = 'Opener') => db.prepare('INSERT INTO events(season_id,title,event_date,tee_time,status) VALUES (?,?,?,?,?)').run(sid, title, date, tee, status).lastInsertRowid;

test('memberLock: earliest non-cancelled event, its first tee time; no tee time = start of day; no event = open', () => {
  const { db } = seedDemoPlusEvents();
  assert.deepEqual(LOCK.memberLock(db, 2027, '2030-01-01T00:00'), { at: null, text: '', locked: false, event: null }, 'no 2027 event: open');
  const sid = season2027(db);
  ev(db, sid, '2027-06-12', '09:00', 'scheduled', 'Later'); ev(db, sid, '2027-01-02', '08:00', 'cancelled', 'Called off'); const first = ev(db, sid, '2027-01-30', '10:16', 'scheduled', 'First');
  const l = LOCK.memberLock(db, 2027, '2027-01-30T10:15');
  assert.equal(l.at, '2027-01-30T10:16'); assert.equal(l.text, 'Sat 30 Jan 2027, 10:16'); assert.equal(l.event.id, first); assert.equal(l.locked, false);
  assert.equal(LOCK.memberLock(db, 2027, '2027-01-30T10:16').locked, true);
  ev(db, sid, '2027-01-23', '', 'scheduled', 'No time');
  assert.equal(LOCK.memberLock(db, 2027, '2027-01-22T23:59').at, '2027-01-23T00:00');
  assert.equal(LOCK.memberLock(db, 2027, '2027-01-23T00:00').locked, true);
});

test('member lock in the app: saves before the first tee time, refused (server-side) after; admin tools unaffected', async (t) => {
  const s = await setup(); t.after(s.close);
  const sid = season2027(s.db); const e = ev(s.db, sid, '2099-01-30', '10:16');
  const c = await s.login('player1'); const five = s.cheap(5);
  assert.match((await c.get('/fantasy-league')).text_, /Changes allowed until Fri 30 Jan 2099, 10:16 \(UK time\)/);
  assert.equal((await save(c, { team_name: 'Before Lock', picks: five, captain: five[0] })).status, 302);
  s.db.prepare("UPDATE events SET event_date='2020-01-30' WHERE id=?").run(e);
  const page = (await c.get('/fantasy-league')).text_; assert.match(page, /id="fl-my-team-locked"/); assert.doesNotMatch(page, /id="fl-my-team-btn"/);
  const g = await c.get('/fantasy-league/my-team'); assert.equal(g.status, 200); assert.match(g.text_, /id="fl-locked"/); assert.match(g.text_, /Before Lock/);
  const before = JSON.stringify(s.db.prepare('SELECT * FROM fantasy_teams ORDER BY id').all());
  const r = await post(c, '/fantasy-league/my-team', { _csrf: await tok(c, '/fantasy-league'), team_name: 'After Lock', picks: five, captain: five[1] });
  assert.equal(r.status, 403); assert.equal(JSON.stringify(s.db.prepare('SELECT * FROM fantasy_teams ORDER BY id').all()), before);
  const b = await s.login('player2');
  assert.equal((await post(b, '/fantasy-league/my-team', { _csrf: await tok(b, '/fantasy-league'), team_name: 'Late Comer', picks: five, captain: five[0] })).status, 403);
  assert.equal(mine(s.db, s.ids.b).length, 0);
  const adm = new Client(s.app.base); assert.equal((await adm.login('pa@t.example')).status, 302);
  const teamA = mine(s.db, s.ids.a)[0];
  assert.equal((await post(adm, `/fantasy-league/admin/teams/${teamA.id}/delete`, { _csrf: await tok(adm, '/fantasy-league') })).status, 302);
  assert.equal(mine(s.db, s.ids.a).length, 0, 'the admin can still remove a team after the lock');
  s.db.prepare('DELETE FROM events WHERE id=?').run(e);
  assert.equal((await save(c, { team_name: 'No Events', picks: five, captain: five[0] })).status, 302);
});
