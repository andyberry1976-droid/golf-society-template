'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, setSetting } = require('../src/db');
const users = require('../src/lib/users');
const H = require('../src/lib/view-helpers');
const { startApp, Client } = require('./helpers');

function site() {
  const db = open(':memory:'); require('../scripts/seed-demo-site').seedDemo(db); setSetting(db, 'feature_fantasy', '1');
  const mk = (name, email, role) => { const id = users.createUser(db, { name, email, passwordHash: users.hashPassword('password-123'), index: 18, joinedOn: '2025-01-01' }); db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id); return id; };
  mk('Test Admin', 'fa-admin@t.example', 'admin'); mk('Test Captain', 'fa-cap@t.example', 'captain'); mk('Test Member', 'fa-mem@t.example', 'member');
  return db;
}

test('date range helpers: one-day unchanged, ranges within a month, across months and years', () => {
  assert.equal(H.dateRange('2027-06-12'), H.dateShort('2027-06-12'));
  assert.equal(H.dateRange('2027-06-12', '2027-06-12'), '12 Jun 2027');
  assert.equal(H.dateRange('2027-06-12', '2027-06-14'), '12–14 Jun 2027');
  assert.equal(H.dateRange('2027-06-30', '2027-07-02'), '30 Jun – 2 Jul 2027');
  assert.equal(H.dateRange('2026-12-30', '2027-01-01'), '30 Dec 2026 – 1 Jan 2027');
  assert.equal(H.dateRangeLong('2027-06-12', null), H.dateLong('2027-06-12'));
  assert.equal(H.dateRangeLongY('2027-06-11', '2027-06-13'), 'Friday 11 – Sunday 13 June 2027');
  assert.equal(H.dayCount('2027-06-11', '2027-06-13'), 3); assert.equal(H.dayCount('2027-06-11'), 1);
});

test('migration: end_date is added to an old events table and existing events stay one-day', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-')), 'old.db');
  let db = open(f); db.prepare("INSERT INTO seasons(name,year,start_date,end_date) VALUES ('2026',2026,'2026-01-01','2026-12-31')").run();
  db.prepare("INSERT INTO events(season_id,title,event_date) VALUES (1,'Old one','2026-05-02')").run();
  db.exec('ALTER TABLE events DROP COLUMN end_date'); db.close();
  db = open(f);
  assert.ok(db.prepare('PRAGMA table_info(events)').all().some((c) => c.name === 'end_date'));
  assert.equal(db.prepare("SELECT end_date FROM events WHERE title='Old one'").get().end_date, null);
  db.close();
});

test('multi-day events: admin creates/edits with an end date or number of days; ranges shown; validation', async () => {
  const db = site(); const app = await startApp(db);
  try {
    const adm = new Client(app.base); await adm.login('fa-admin@t.example');
    const form = await adm.get('/admin/events/new'); assert.equal(form.status, 200); assert.match(form.text_, /name="end_date"/); assert.match(form.text_, /name="days"/);
    const season = db.prepare('SELECT id FROM seasons ORDER BY year DESC LIMIT 1').get().id;
    const base = { title: 'Algarve Tour', season_id: String(season), event_date: '2099-06-12', tee_time: '09:00', format: 'stableford', scoring_basis: 'stableford', allowance_pct: '95', points_multiplier: '1', status: 'scheduled' };
    let r = await adm.post('/admin/events', { ...base, end_date: '2099-06-14' }); assert.equal(r.status, 302);
    const id = Number(r.headers.get('location').split('/').pop());
    assert.equal(db.prepare('SELECT end_date FROM events WHERE id=?').get(id).end_date, '2099-06-14');
    const pg = await adm.get('/events/' + id); assert.match(pg.text_, /Friday 12 – Sunday 14 June 2099 \(3 days\)/);
    assert.match((await adm.get('/events')).text_, /Friday 12 – Sunday 14 June/);
    assert.match((await adm.get('/admin/events')).text_, /12–14 Jun 2099/);
    // edit: number of days instead of an end date
    r = await adm.post('/admin/events/' + id, { ...base, end_date: '', days: '4' }); assert.equal(r.status, 302);
    assert.equal(db.prepare('SELECT end_date FROM events WHERE id=?').get(id).end_date, '2099-06-15');
    assert.match((await adm.get('/admin/events/' + id + '/edit')).text_, /name="end_date" type="date" value="2099-06-15"/);
    // same day = one-day (NULL); end before start refused
    r = await adm.post('/admin/events/' + id, { ...base, end_date: '2099-06-12' }); assert.equal(r.status, 302);
    assert.equal(db.prepare('SELECT end_date FROM events WHERE id=?').get(id).end_date, null);
    assert.doesNotMatch((await adm.get('/events/' + id)).text_, /days\)/);
    r = await adm.post('/admin/events/' + id, { ...base, end_date: '2099-06-10' }); assert.equal(r.status, 422); assert.match(r.text_, /can’t be before the start date/);
    r = await adm.post('/admin/events/' + id, { ...base, end_date: '2099-07-30' }); assert.equal(r.status, 422); assert.match(r.text_, /at most 14 days/);
    r = await adm.post('/admin/events/' + id, { ...base, end_date: 'nonsense' }); assert.equal(r.status, 422);
    // an event that started yesterday and ends tomorrow still counts as upcoming
    const Q = require('../src/lib/queries'); const t = Q.today(); const d = (n) => new Date(Date.parse(t + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
    db.prepare("UPDATE events SET event_date=?, end_date=? WHERE id=?").run(d(-1), d(1), id);
    assert.ok(Q.upcomingEvents(db).some((e) => e.id === id)); assert.ok(!Q.pastEvents(db).some((e) => e.id === id));
  } finally { await app.close(); }
});

test('fantasy admin: only admins see/use it; add golfer with price; enter a team within the rules', async () => {
  const db = site(); const app = await startApp(db);
  try {
    const anon = new Client(app.base); const mem = new Client(app.base); const cap = new Client(app.base); const adm = new Client(app.base);
    await mem.login('fa-mem@t.example'); await cap.login('fa-cap@t.example'); await adm.login('fa-admin@t.example');
    for (const c of [anon, mem, cap]) { const r = await c.get('/fantasy-league'); assert.equal(r.status, 200); assert.doesNotMatch(r.text_, /id="fl-admin"/); }
    const pg = await adm.get('/fantasy-league'); assert.match(pg.text_, /id="fl-admin"/); assert.match(pg.text_, /Admin: add players/);
    assert.equal((await mem.post('/fantasy-league/admin/players', { name: 'Hacker', price: '5' })).status, 403);
    assert.equal((await cap.post('/fantasy-league/admin/teams', { team_name: 'x' })).status, 403);
    assert.equal((await anon.req('POST', '/fantasy-league/admin/players', { form: { name: 'Hacker', price: '5' } })).status, 403, 'no CSRF token');
    assert.equal((await adm.req('POST', '/fantasy-league/admin/players', { form: { name: 'No Token', price: '5' } })).status, 403, 'admin without CSRF token');
    // add golfers
    let r = await adm.post('/fantasy-league/admin/players', { name: 'New Signing', price: '4.5' }); assert.equal(r.status, 302);
    assert.equal(db.prepare("SELECT price FROM fantasy_pool WHERE name='New Signing'").get().price, 4.5);
    assert.match((await anon.get('/fantasy-league')).text_, /New Signing<\/td><td class="r"><strong>£4\.5m/);
    r = await adm.post('/fantasy-league/admin/players', { name: 'new signing', price: '6' }); assert.equal(r.status, 422); assert.match(r.text_, /already in the player pool/);
    r = await adm.post('/fantasy-league/admin/players', { name: 'Cheap', price: '0.3' }); assert.equal(r.status, 422); assert.match(r.text_, /£0\.5m steps/);
    r = await adm.post('/fantasy-league/admin/players', { name: 'Odd', price: '4.3' }); assert.equal(r.status, 422);
    r = await adm.post('/fantasy-league/admin/players', { name: '', price: '5' }); assert.equal(r.status, 422);
    const FL = require('../src/lib/fantasy'); const { getSettings } = require('../src/db'); const y = db.prepare("SELECT MAX(s.year) y FROM seasons s JOIN events e ON e.season_id=s.id WHERE e.status='completed'").get().y;
    const base = FL.livePrices(db, y, FL.rulesFrom(getSettings(db))); const listed = require('../src/lib/fantasy-admin').pool(db, base.season, base);
    r = await adm.post('/fantasy-league/admin/players', { name: listed[0].name, price: '5' }); assert.equal(r.status, 422, 'priced players cannot be added twice');
    // teams: squad of 5, within £50m, captain in squad
    const cheap = listed.slice().sort((a, b) => a.price - b.price); const five = cheap.slice(0, 5).map((p) => p.name);
    const dear = listed.slice(0, 5).map((p) => p.name); assert.ok(listed.slice(0, 5).reduce((s, p) => s + p.price, 0) > 50, 'top five cost more than the budget');
    const tok = async () => (await adm.csrf());
    const team = async (o) => { const t = await tok(); const body = new URLSearchParams({ _csrf: t, manager_name: o.manager_name || '', team_name: o.team_name || '', user_id: o.user_id || '', captain: o.captain || '' }); for (const p of o.picks || []) body.append('picks', p); return adm.req('POST', '/fantasy-league/admin/teams', { form: body }); };
    r = await team({ manager_name: 'Player 77', team_name: 'Too Rich', picks: dear, captain: dear[0] }); assert.equal(r.status, 422); assert.match(r.text_, /over the £50m budget/);
    r = await team({ manager_name: 'Player 77', team_name: 'Short', picks: five.slice(0, 4), captain: five[0] }); assert.equal(r.status, 422); assert.match(r.text_, /Pick exactly 5 players/);
    r = await team({ manager_name: 'Player 77', team_name: 'Twice', picks: [five[0], five[0], five[1], five[2], five[3]], captain: five[0] }); assert.equal(r.status, 422); assert.match(r.text_, /picked twice/);
    r = await team({ manager_name: 'Player 77', team_name: 'Ghost', picks: [...five.slice(0, 4), 'Player 74'], captain: five[0] }); assert.equal(r.status, 422); assert.match(r.text_, /isn’t in the player pool/);
    r = await team({ manager_name: 'Player 77', team_name: 'No Cap', picks: five, captain: dear[0] === five[0] ? 'x' : 'Nobody' }); assert.equal(r.status, 422); assert.match(r.text_, /Pick a captain/);
    r = await team({ manager_name: 'Player 77', team_name: 'Player 77 Team', picks: five, captain: five[2] }); assert.equal(r.status, 302);
    const row = db.prepare("SELECT * FROM fantasy_teams WHERE team_name='Player 77 Team'").get(); assert.equal(row.captain, five[2]); assert.equal(JSON.parse(row.picks).length, 5);
    r = await team({ manager_name: 'Someone', team_name: 'player 77 team', picks: five, captain: five[0] }); assert.equal(r.status, 422); assert.match(r.text_, /team name is taken/);
    // member's team on their behalf: one per member
    const uid = String(db.prepare("SELECT id FROM users WHERE email='fa-mem@t.example'").get().id);
    r = await team({ user_id: uid, team_name: 'Member XI', picks: five, captain: five[0] }); assert.equal(r.status, 302);
    assert.equal(db.prepare("SELECT manager_name FROM fantasy_teams WHERE team_name='Member XI'").get().manager_name, 'Test Member');
    r = await team({ user_id: uid, team_name: 'Member XII', picks: five, captain: five[0] }); assert.equal(r.status, 422); assert.match(r.text_, /already has a team/);
    const pub = (await anon.get('/fantasy-league')).text_; assert.match(pub, /Teams entered \(2\)/); assert.match(pub, new RegExp(five[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' \\(C\\)'));
    // a golfer in a team can't be removed; others can; teams can be removed by an admin
    const ns = db.prepare("SELECT id FROM fantasy_pool WHERE name='New Signing'").get().id;
    const inTeam = five.includes('New Signing');
    r = await adm.post(`/fantasy-league/admin/players/${ns}/delete`); assert.equal(r.status, 302);
    assert.equal(!!db.prepare('SELECT 1 FROM fantasy_pool WHERE id=?').get(ns), inTeam);
    assert.equal((await mem.post(`/fantasy-league/admin/teams/${row.id}/delete`)).status, 403);
    r = await adm.post(`/fantasy-league/admin/teams/${row.id}/delete`); assert.equal(r.status, 302); assert.equal(db.prepare('SELECT 1 FROM fantasy_teams WHERE id=?').get(row.id), undefined);
    await adm.post('/fantasy-league/admin/players', { name: 'Pick Me', price: '0.5' });
    const pm = db.prepare("SELECT id FROM fantasy_pool WHERE name='Pick Me'").get().id;
    r = await team({ manager_name: 'Player 94', team_name: 'Player 94 XI', picks: [...five.slice(0, 4), 'Pick Me'], captain: 'Pick Me' }); assert.equal(r.status, 302);
    r = await adm.post(`/fantasy-league/admin/players/${pm}/delete`); assert.equal(r.status, 302); assert.match((await adm.get('/fantasy-league')).text_, /Pick Me is in a team/); assert.ok(db.prepare('SELECT 1 FROM fantasy_pool WHERE id=?').get(pm), 'picked golfer kept');
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action LIKE 'fantasy_%'").get().n >= 4);
  } finally { await app.close(); }
});

test('first admin is created when seed members exist but nobody can log in as admin; never duplicated', () => {
  const { ensureAdmin } = require('../src/server'); const db = open(':memory:');
  db.prepare("INSERT INTO users(name,email,role) VALUES ('Seeded One','seed1@t.example','admin')").run(); // seeded, no login
  const cfg = { adminEmail: 'admin2@t.example', adminPassword: 'a-long-password-1', adminName: 'Admin', production: false, demoPassword: 'x' };
  ensureAdmin(db, cfg);
  assert.equal(db.prepare("SELECT role FROM users WHERE email='admin2@t.example'").get().role, 'admin');
  ensureAdmin(db, cfg); assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE email='admin2@t.example'").get().n, 1);
});

test('optional per-site theme.css is appended to the theme; generic wording (no flamingo copy)', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path'); const site = require('../src/site');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'th-')); fs.writeFileSync(path.join(dir, 'theme.css'), '.hero{color:red}</style>');
  assert.equal(site.themeCss({ dir, branding: { colors: { primary: '#112233' } } }), ':root{--em:#112233}.hero{color:red}>');
  assert.equal(site.themeCss({ branding: {} }), '');
  for (const f of ['src/views/join-done.ejs', 'src/views/admin/settings.ejs']) assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /flock|Pink socks|is pink/);
});
