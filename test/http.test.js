'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { miniSociety, addEvent, startApp, Client } = require('./helpers');
const users = require('../src/lib/users');
const rsvp = require('../src/lib/rsvp');

async function setup(over) {
  const m = miniSociety([10, 14, 18, 22]);
  const { db, ids } = m;
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(ids[0]);
  db.prepare("UPDATE users SET role='captain' WHERE id=?").run(ids[1]);
  const ev = addEvent(db, { season: m.season, course: m.course, title: 'Future Cup', date: '2099-05-02', capacity: 2 });
  const srv = await startApp(db, over);
  const as = async (i) => { const c = new Client(srv.base); const r = await c.login(`p${i + 1}@t.example`); assert.equal(r.status, 302, 'login ok for p' + (i + 1)); return c; };
  return { ...m, ...srv, ev, as, anon: () => new Client(srv.base) };
}

test('public pages render for anonymous visitors', async (t) => {
  const s = await setup(); t.after(s.close);
  const c = s.anon();
  for (const p of ['/', '/events', `/events/${s.ev}`, '/players', `/players/${s.ids[0]}`, '/standings', '/records', '/honours', '/awards', '/login', '/join', '/healthz']) {
    const r = await c.get(p);
    assert.equal(r.status, 200, p);
  }
  assert.equal((await c.get('/nope')).status, 404);
  assert.equal((await c.get('/events/99999')).status, 404);
  assert.equal((await c.get('/players/99999')).status, 404);
});

test('security headers & cookie flags', async (t) => {
  const s = await setup(); t.after(s.close);
  const r = await fetch(s.base + '/login');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
  const ck = r.headers.getSetCookie().join(';');
  assert.match(ck, /fs\.sid=/);
  assert.match(ck, /HttpOnly/i);
  assert.match(ck, /SameSite=Lax/i);
});

test('anonymous users are sent to log in for admin and RSVP', async (t) => {
  const s = await setup(); t.after(s.close);
  const c = s.anon();
  const r = await c.get('/admin');
  assert.equal(r.status, 302);
  assert.match(r.headers.get('location'), /^\/login\?next=/);
  const r2 = await c.post(`/events/${s.ev}/rsvp`, { status: 'going' });
  assert.equal(r2.status, 302);
  assert.match(r2.headers.get('location'), /^\/login/);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rsvps').get().n, 0);
});

test('CSRF: POSTs without a valid token are rejected', async (t) => {
  const s = await setup(); t.after(s.close);
  const c = await s.as(2);
  const r = await c.req('POST', `/events/${s.ev}/rsvp`, { form: { status: 'going' } });
  assert.equal(r.status, 403);
  const r2 = await c.req('POST', `/events/${s.ev}/rsvp`, { form: { status: 'going', _csrf: 'wrong' } });
  assert.equal(r2.status, 403);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rsvps').get().n, 0);
  const r3 = await c.post(`/events/${s.ev}/rsvp`, { status: 'going' });
  assert.equal(r3.status, 302);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rsvps').get().n, 1);
  // logout & login also need a token
  assert.equal((await new Client(s.base).req('POST', '/login', { form: { email: 'p1@t.example', password: 'password-123' } })).status, 403);
});

test('role-based access: member / captain / admin', async (t) => {
  const s = await setup(); t.after(s.close);
  const admin = await s.as(0); const cap = await s.as(1); const mem = await s.as(2);
  const adminOnly = ['/admin/requests', '/admin/members', '/admin/seasons', '/admin/honours', '/admin/settings', '/admin/backup'];
  const staffPages = ['/admin', '/admin/events', '/admin/events/new', `/admin/events/${s.ev}/edit`, `/admin/events/${s.ev}/results`, '/admin/awards', '/admin/courses', '/admin/records'];
  for (const p of [...adminOnly, ...staffPages]) assert.equal((await mem.get(p)).status, 403, 'member blocked: ' + p);
  for (const p of staffPages) assert.equal((await cap.get(p)).status, 200, 'captain allowed: ' + p);
  for (const p of adminOnly) assert.equal((await cap.get(p)).status, 403, 'captain blocked: ' + p);
  for (const p of [...staffPages, ...adminOnly.filter((p) => p !== '/admin/backup')]) assert.equal((await admin.get(p)).status, 200, 'admin allowed: ' + p);
  const bk = await fetch(s.base + '/admin/backup', { headers: { cookie: admin._cookieHeader() } });
  assert.equal(bk.status, 200);
  assert.ok((await bk.arrayBuffer()).byteLength > 10000);
  // mutating endpoints too
  const mp = await mem.post(`/admin/events/${s.ev}`, { title: 'Hacked' });
  assert.equal(mp.status, 403);
  const mr = await mem.post(`/admin/events/${s.ev}/results`, { 'rows[u1][gross]': '70' });
  assert.equal(mr.status, 403);
  assert.equal((await cap.post('/admin/members', { name: 'X Y', email: 'x@y.co', password: 'password-123', role: 'admin' })).status, 403);
  assert.equal((await cap.post('/admin/settings', { society_name: 'Mine now' })).status, 403);
  assert.equal(s.db.prepare("SELECT value FROM settings WHERE key='society_name'").get().value, 'The Demo Golf Society');
  assert.equal((await mem.post(`/events/${s.ev}/rsvp-admin`, { user_id: s.ids[3], action: 'going' })).status, 403);
  assert.equal((await cap.post(`/events/${s.ev}/rsvp-admin`, { user_id: s.ids[3], action: 'going' })).status, 302);
  assert.equal(s.db.prepare("SELECT status FROM rsvps WHERE user_id=?").get(s.ids[3]).status, 'going');
});

test('captain can create/edit events and enter results (handicaps update)', async (t) => {
  const s = await setup(); t.after(s.close);
  const cap = await s.as(1);
  const r = await cap.post('/admin/events', { title: 'Captain Cup', season_id: s.season, course_id: s.course, event_date: '2026-03-07', tee_time: '09:30', format: 'stableford', scoring_basis: 'stableford', cost: '25', capacity: '8', notes: 'Bring pencil', counts_handicap: '1', counts_oom: '1', points_multiplier: '1', allowance_pct: '95' });
  assert.equal(r.status, 302);
  const evId = Number(r.headers.get('location').split('/').pop());
  const row = s.db.prepare('SELECT * FROM events WHERE id=?').get(evId);
  assert.equal(row.cost_pence, 2500); assert.equal(row.capacity, 8);
  const bad = await cap.post('/admin/events', { title: 'x', season_id: s.season, event_date: 'nope', tee_time: '25:00', format: 'stableford', scoring_basis: 'stableford', points_multiplier: '1', allowance_pct: '95' });
  assert.equal(bad.status, 422);
  const res = await cap.post(`/admin/events/${evId}/results`, { 'rows[u1][stableford]': '41', 'rows[u2][gross]': '90', 'rows[u3][stableford]': '', highlights: 'Nearest the pin: Me' });
  assert.equal(res.status, 302, (res.text_||'').match(/class="flash[^>]*>[\s\S]{0,300}/)?.[0]);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM results WHERE event_id=?').get(evId).n, 2);
  assert.equal(s.db.prepare('SELECT status FROM events WHERE id=?').get(evId).status, 'completed');
  assert.equal(s.db.prepare('SELECT position FROM results WHERE event_id=? AND user_id=1').get(evId).position, 1);
  const invalid = await cap.post(`/admin/events/${evId}/results`, { 'rows[u1][stableford]': '-4' });
  assert.equal(invalid.status, 422);
  assert.match(invalid.text_, /Invalid value for stb/);
});

test('login: wrong password, unknown user, disabled user, safe redirects', async (t) => {
  const s = await setup(); t.after(s.close);
  const c = s.anon();
  const bad = await c.login('p1@t.example', 'nope-nope-nope');
  assert.equal(bad.status, 401);
  assert.match(bad.text_, /Email or password not recognised/);
  const unknown = await c.login('nobody@t.example', 'password-123');
  assert.equal(unknown.status, 401);
  assert.match(unknown.text_, /Email or password not recognised/); // same message: no user enumeration
  s.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(s.ids[3]);
  assert.equal((await c.login('p4@t.example')).status, 401);
  // open-redirect attempt is neutralised
  const tok = await c.csrf();
  const r = await c.req('POST', '/login', { form: { _csrf: tok, email: 'p3@t.example', password: 'password-123', next: 'https://evil.example/x' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/');
  const c2 = s.anon(); const tok2 = await c2.csrf();
  const r2 = await c2.req('POST', '/login', { form: { _csrf: tok2, email: 'p3@t.example', password: 'password-123', next: '//evil.example' } });
  assert.equal(r2.headers.get('location'), '/');
  const c3 = s.anon(); const tok3 = await c3.csrf();
  const r3 = await c3.req('POST', '/login', { form: { _csrf: tok3, email: 'p3@t.example', password: 'password-123', next: '/events' } });
  assert.equal(r3.headers.get('location'), '/events');
});

test('login is rate limited', async (t) => {
  const s = await setup({ loginLimit: { windowMs: 60000, limit: 3 } }); t.after(s.close);
  const c = s.anon();
  for (let i = 0; i < 3; i++) assert.equal((await c.login('p1@t.example', 'wrong-password')).status, 401);
  const blocked = await c.login('p1@t.example', 'wrong-password');
  assert.equal(blocked.status, 429);
  // even the right password is refused while limited
  assert.equal((await c.login('p1@t.example')).status, 429);
});

test('join request -> admin approval -> login; duplicates & validation', async (t) => {
  const s = await setup(); t.after(s.close);
  const v = s.anon();
  const bad = await v.post('/join', { name: 'A', email: 'nope', password: 'short', password2: 'x' });
  assert.equal(bad.status, 422);
  const ok = await v.post('/join', { name: 'Player 71', email: 'player71@t.example', password: 'newbie-pass-1', password2: 'newbie-pass-1', handicap: '18.4', home_course: 'Hole', invite_code: '', message: 'hi' });
  assert.equal(ok.status, 200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM join_requests WHERE status='pending'").get().n, 1);
  assert.equal((await v.login('player71@t.example', 'newbie-pass-1')).status, 401); // not approved yet
  assert.equal((await v.post('/join', { name: 'Dup', email: 'player71@t.example', password: 'newbie-pass-1', password2: 'newbie-pass-1' })).status, 422);
  assert.equal((await v.post('/join', { name: 'Dup', email: 'p1@t.example', password: 'newbie-pass-1', password2: 'newbie-pass-1' })).status, 422);
  const wrongCode = await v.post('/join', { name: 'Player 69', email: 'player69@t.example', password: 'newbie-pass-1', password2: 'newbie-pass-1', invite_code: 'WRONG' });
  assert.equal(wrongCode.status, 422);
  const admin = await s.as(0);
  const reqId = s.db.prepare("SELECT id FROM join_requests WHERE email='player71@t.example'").get().id;
  assert.equal((await s.as(2).then((m) => m.post(`/admin/requests/${reqId}/approve`, { index: '18.4', role: 'member' }))).status, 403);
  const ap = await admin.post(`/admin/requests/${reqId}/approve`, { index: '18.4', role: 'member' });
  assert.equal(ap.status, 302);
  const li = await v.login('player71@t.example', 'newbie-pass-1');
  assert.equal(li.status, 302);
  const me = s.db.prepare("SELECT * FROM users WHERE email='player71@t.example'").get();
  assert.equal(me.handicap_index, 18.4); assert.equal(me.role, 'member');
  assert.equal((await admin.post(`/admin/requests/${reqId}/approve`, { index: '1', role: 'member' })).status, 302); // double approve: flash error, no dup
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM users WHERE email='player71@t.example'").get().n, 1);
});

test('invite code flags requests and can auto-approve', async (t) => {
  const s = await setup(); t.after(s.close);
  const v = s.anon();
  await v.post('/join', { name: 'Player 70', email: 'player70@t.example', password: 'newbie-pass-1', password2: 'newbie-pass-1', invite_code: 'changeme' });
  assert.equal(s.db.prepare("SELECT invite_ok FROM join_requests WHERE email='player70@t.example'").get().invite_ok, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM users WHERE email='player70@t.example'").get().n, 0);
  s.db.prepare("UPDATE settings SET value='1' WHERE key='invite_auto_approve'").run();
  const r = await v.post('/join', { name: 'Player 68', email: 'player68@t.example', password: 'newbie-pass-1', password2: 'newbie-pass-1', invite_code: 'CHANGEME' });
  assert.equal(r.status, 200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM users WHERE email='player68@t.example'").get().n, 1);
  assert.equal((await v.login('player68@t.example', 'newbie-pass-1')).status, 302);
});

test('RSVP via HTTP: full event -> waitlist -> promotion + notice; closed for past events', async (t) => {
  const s = await setup(); t.after(s.close);
  const a = await s.as(0); const b = await s.as(1); const c = await s.as(2); const d = await s.as(3);
  await a.post(`/events/${s.ev}/rsvp`, { status: 'going' });
  await b.post(`/events/${s.ev}/rsvp`, { status: 'going' });
  await c.post(`/events/${s.ev}/rsvp`, { status: 'going' });
  await d.post(`/events/${s.ev}/rsvp`, { status: 'going' });
  const st = (i) => s.db.prepare('SELECT status FROM rsvps WHERE user_id=? AND event_id=?').get(s.ids[i], s.ev).status;
  assert.deepEqual([0, 1, 2, 3].map(st), ['going', 'going', 'waitlist', 'waitlist']);
  assert.match((await c.get(`/events/${s.ev}`)).text_, /#1 on the waitlist/);
  await a.post(`/events/${s.ev}/rsvp`, { status: 'not_going' });
  assert.deepEqual([0, 1, 2, 3].map(st), ['not_going', 'going', 'going', 'waitlist']);
  const acct = await c.get('/account');
  assert.match(acct.text_, /now IN for Future Cup/);
  // past/cancelled events refuse RSVPs
  const past = addEvent(s.db, { season: s.season, course: s.course, title: 'Old', date: '2020-01-01' });
  await a.post(`/events/${past}/rsvp`, { status: 'going' });
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM rsvps WHERE event_id=?').get(past).n, 0);
  // invalid status
  const r = await a.post(`/events/${s.ev}/rsvp`, { status: 'hax' });
  assert.equal(r.status, 302);
  assert.equal(st(0), 'not_going');
});

test('admin cannot demote or disable the last admin; disabled members lose access', async (t) => {
  const s = await setup(); t.after(s.close);
  const admin = await s.as(0);
  const r = await admin.post(`/admin/members/${s.ids[0]}`, { name: 'Player 1', email: 'p1@t.example', nickname: '', home_course: '', role: 'member', status: 'active' });
  assert.equal(r.status, 422);
  assert.match(r.text_, /at least one active admin/);
  assert.equal(s.db.prepare('SELECT role FROM users WHERE id=?').get(s.ids[0]).role, 'admin');
  const mem = await s.as(2);
  assert.equal((await mem.get('/account')).status, 200);
  await admin.post(`/admin/members/${s.ids[2]}`, { name: 'Player 3', email: 'p3@t.example', nickname: '', home_course: '', role: 'member', status: 'disabled' });
  const after = await mem.get('/account');
  assert.equal(after.status, 302); // session no longer valid
});

test('XSS: user supplied text is escaped in pages', async (t) => {
  const s = await setup(); t.after(s.close);
  const mem = await s.as(2);
  await mem.post('/account', { name: '<script>alert(1)</script> Eve', nickname: '"><img src=x onerror=alert(2)>', home_course: '', bio: '<b>bold</b>' });
  const page = (await mem.get(`/players/${s.ids[2]}`)).text_;
  assert.ok(!page.includes('<script>alert(1)'));
  assert.ok(!page.includes('<img src=x'));
  assert.ok(page.includes('&lt;script&gt;'));
  const list = (await s.anon().get('/players')).text_;
  assert.ok(!list.includes('<img src=x onerror'));
});

test('password change requires the current password; sessions regenerate on login', async (t) => {
  const s = await setup(); t.after(s.close);
  const c = await s.as(2);
  const bad = await c.post('/account/password', { current_password: 'wrong-wrong', new_password: 'brand-new-pass-1', new_password2: 'brand-new-pass-1' });
  assert.equal(bad.status, 422);
  const ok = await c.post('/account/password', { current_password: 'password-123', new_password: 'brand-new-pass-1', new_password2: 'brand-new-pass-1' });
  assert.equal(ok.status, 302);
  assert.equal((await s.anon().login('p3@t.example', 'password-123')).status, 401);
  assert.equal((await s.anon().login('p3@t.example', 'brand-new-pass-1')).status, 302);
  // stored hashes are bcrypt, never plaintext
  const h = s.db.prepare('SELECT password_hash FROM users WHERE id=?').get(s.ids[2]).password_hash;
  assert.match(h, /^\$2[aby]\$/);
});

test('members-only mode hides content from visitors', async (t) => {
  const s = await setup(); t.after(s.close);
  s.db.prepare("UPDATE settings SET value='1' WHERE key='members_only'").run();
  const v = s.anon();
  assert.equal((await v.get('/')).status, 200);
  assert.equal((await v.get('/join')).status, 200);
  for (const p of ['/events', '/players', '/standings', '/records']) assert.equal((await v.get(p)).status, 302, p);
  const m = await s.as(2);
  assert.equal((await m.get('/players')).status, 200);
});

test('settings rebrand the site; season & scheme editing works', async (t) => {
  const s = await setup(); t.after(s.close);
  const a = await s.as(0);
  const r = await a.post('/admin/settings', { society_name: 'The Birdie Badgers Golf Society', short_name: 'Birdie Badgers', hero_title: 'The Birdie Badgers', hero_ribbon: 'Golf Club', est_text: 'Est. 1999', tagline: 'Hello', join_blurb: 'Join', footer_blurb: 'Foot', currency: '€', contact_email: '', invite_code: 'BADGER', default_allowance: '95', max_index: '54', default_start_index: '28', positions: '20, 10, 5', participation: '2', best_n: '4', soft_cap: '1', hard_cap: '1' });
  assert.equal(r.status, 302);
  const home = (await s.anon().get('/')).text_;
  assert.match(home, /Birdie Badgers/);
  assert.ok(!home.includes('Fairway Flamingos'));
  const sch = JSON.parse(s.db.prepare("SELECT value FROM settings WHERE key='oom_default_scheme'").get().value);
  assert.deepEqual(sch, { mode: 'points', countback: false, positions: [20, 10, 5], participation: 2, bestN: 4 });
  const bad = await a.post('/admin/settings', { society_name: '', short_name: '', hero_title: '', currency: '', default_allowance: 'x', max_index: '54', default_start_index: '28', positions: 'a,b', participation: '2' });
  assert.equal(bad.status, 422);
  const sn = await a.post('/admin/seasons', { name: '2027', year: '2027', start_date: '2027-01-01', end_date: '2027-12-31' });
  assert.equal(sn.status, 302);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM seasons WHERE name='2027'").get().n, 1);
});
