'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { miniSociety, addEvent, startApp, Client } = require('./helpers');
const { open } = require('../src/db');

// p1 admin, p2 captain, p3 + p4 members (all with email logins, password 'password-123')
async function setup(over = { adminLoginOnly: true }) {
  const m = miniSociety([10, 14, 18, 22]);
  const { db, ids } = m;
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(ids[0]);
  db.prepare("UPDATE users SET role='captain' WHERE id=?").run(ids[1]);
  const ev = addEvent(db, { season: m.season, course: m.course, title: 'Future Cup', date: '2099-05-02' });
  const srv = await startApp(db, over);
  const admin = new Client(srv.base);
  assert.equal((await admin.login('p1@t.example')).status, 302, 'admin email login still works');
  return { ...m, ...srv, ev, admin };
}
const tokenFrom = async (c, p) => { const r = await c.get(p); const mm = r.text_.match(/name="_csrf" value="([^"]+)"/); assert.ok(mm, 'csrf on ' + p); return mm[1]; };
const postAt = async (c, page, action, form) => c.req('POST', action, { form: { _csrf: await tokenFrom(c, page), ...form } });
const setLogin = (s, id, form) => postAt(s.admin, `/admin/members/${id}`, `/admin/members/${id}/login`, form);
async function memberLogin(base, username, password) {
  const c = new Client(base);
  const r = await c.req('POST', '/login', { form: { _csrf: await tokenFrom(c, '/login'), email: username, password } });
  return { c, r };
}
const user = (db, id) => db.prepare('SELECT * FROM users WHERE id=?').get(id);

test('migration: adds a nullable username column + case-insensitive unique index without touching existing members', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ml-')), 'old.db');
  let db = open(file);
  db.prepare("INSERT INTO users(name,email,password_hash) VALUES ('Old Member','old@t.example','x')").run();
  db.exec('DROP INDEX idx_users_username; ALTER TABLE users DROP COLUMN username'); // simulate a database from before this change
  const before = db.prepare('SELECT * FROM users ORDER BY id').all();
  db.close();
  db = open(file);
  const cols = db.prepare('PRAGMA table_info(users)').all();
  const col = cols.find((c) => c.name === 'username');
  assert.ok(col && col.notnull === 0, 'username column added, nullable');
  assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all().map(({ username, ...r }) => { assert.equal(username, null); return r; }), before);
  db.prepare("UPDATE users SET username='bob' WHERE email='old@t.example'").run();
  db.prepare("INSERT INTO users(name,email) VALUES ('Two','two@t.example')").run();
  assert.throws(() => db.prepare("UPDATE users SET username='BOB' WHERE email='two@t.example'").run(), /UNIQUE/);
  db.prepare("INSERT INTO users(name,email) VALUES ('Three','three@t.example')").run(); // many NULL usernames are fine
  db.close();
});

test('admin sets a member login: validated, unique (case-insensitive), password stored hashed', async (t) => {
  const s = await setup(); t.after(s.close);
  const [, , m3, m4] = s.ids;
  const page = (await s.admin.get(`/admin/members/${m3}`)).text_;
  assert.match(page, /id="member-login"/); assert.match(page, /Set up member login/);
  assert.match((await s.admin.get('/admin/members')).text_, /<th>Login<\/th>/);
  // first time: password required
  await setLogin(s, m3, { username: 'bob.smith', password: '' });
  assert.equal(user(s.db, m3).username, null);
  await setLogin(s, m3, { username: 'b', password: 'long-enough-pw' }); // bad username
  await setLogin(s, m3, { username: 'bob.smith', password: 'short' }); // short password
  assert.equal(user(s.db, m3).username, null);
  const oldHash = user(s.db, m3).password_hash;
  const r = await setLogin(s, m3, { username: '  Bob.Smith ', password: 'first-pass-123' });
  assert.equal(r.status, 302);
  const u = user(s.db, m3);
  assert.equal(u.username, 'bob.smith');
  assert.notEqual(u.password_hash, oldHash);
  assert.match(u.password_hash, /^\$2[aby]\$/); assert.doesNotMatch(u.password_hash, /first-pass-123/);
  assert.doesNotMatch(JSON.stringify(s.db.prepare('SELECT * FROM audit_log').all()), /first-pass-123/);
  // another member can't take the same username in a different case
  await setLogin(s, m4, { username: 'BOB.SMITH', password: 'other-pass-123' });
  assert.equal(user(s.db, m4).username, null);
  // rename without a new password keeps the password
  await setLogin(s, m3, { username: 'bobby', password: '' });
  assert.equal(user(s.db, m3).username, 'bobby'); assert.equal(user(s.db, m3).password_hash, u.password_hash);
});

test('member logs in with username (admin-only site): success, failures, and no admin/captain powers', async (t) => {
  const s = await setup(); t.after(s.close);
  const [, cap, m3, m4] = s.ids;
  await setLogin(s, m3, { username: 'bob', password: 'first-pass-123' });
  await setLogin(s, cap, { username: 'skipper', password: 'skipper-pass-1' });
  assert.match((await new Client(s.base).get('/')).text_, /href="\/login">Member login</);
  assert.equal((await memberLogin(s.base, 'bob', 'wrong-pass-123')).r.status, 401);
  assert.equal((await memberLogin(s.base, 'nobody', 'first-pass-123')).r.status, 401);
  assert.equal((await memberLogin(s.base, 'p4@t.example', 'password-123')).r.status, 401, 'member email logins stay off on an admin-only site');
  assert.equal((await memberLogin(s.base, 'p3@t.example', 'first-pass-123')).r.status, 401, 'email login stays admin-only even with the new password');
  const { c, r } = await memberLogin(s.base, 'BoB', 'first-pass-123'); // case-insensitive
  assert.equal(r.status, 302);
  const home = (await c.get('/')).text_;
  assert.match(home, /Change password/); assert.match(home, /Log out/); assert.doesNotMatch(home, /href="\/admin"/);
  for (const p of ['/admin', '/admin/members', `/admin/members/${m4}`, '/admin/backup', '/admin/settings']) assert.equal((await c.get(p)).status, 403, p);
  const tok = await tokenFrom(c, '/account/password');
  for (const [p, f] of [[`/admin/members/${m4}/password`, { password: 'hijack-pass-123' }], [`/admin/members/${m4}/login`, { username: 'evil', password: 'hijack-pass-123' }], [`/events/${s.ev}/rsvp-admin`, { user_id: m4, action: 'going' }]]) {
    assert.equal((await c.req('POST', p, { form: { _csrf: tok, ...f } })).status, 403, p);
  }
  assert.equal(user(s.db, m4).username, null);
  // a captain signing in with a username is still only a member
  const sk = await memberLogin(s.base, 'skipper', 'skipper-pass-1');
  assert.equal(sk.r.status, 302);
  assert.equal((await sk.c.get('/admin')).status, 403);
  assert.equal((await sk.c.req('POST', `/events/${s.ev}/rsvp-admin`, { form: { _csrf: await tokenFrom(sk.c, '/account/password'), user_id: m4, action: 'going' } })).status, 403);
  // disabled members can't log in
  s.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(m3);
  assert.equal((await memberLogin(s.base, 'bob', 'first-pass-123')).r.status, 401);
  assert.notEqual((await c.get('/account/password')).status, 200, 'existing session ends when disabled');
});

test('member changes own password: needs the current one and a 10+ character new one', async (t) => {
  const s = await setup(); t.after(s.close);
  const m3 = s.ids[2];
  await setLogin(s, m3, { username: 'bob', password: 'first-pass-123' });
  const { c } = await memberLogin(s.base, 'bob', 'first-pass-123');
  assert.equal((await c.get('/account')).headers.get('location'), '/account/password');
  const pg = await c.get('/account/password');
  assert.equal(pg.status, 200); assert.match(pg.text_, /Signed in as bob/);
  const chg = (f) => postAt(c, '/account/password', '/account/password', { via: 'page', ...f });
  assert.equal((await chg({ current_password: 'nope-nope-nope', new_password: 'second-pass-123', new_password2: 'second-pass-123' })).status, 422);
  assert.equal((await chg({ current_password: 'first-pass-123', new_password: 'short', new_password2: 'short' })).status, 422);
  assert.equal((await chg({ current_password: 'first-pass-123', new_password: 'second-pass-123', new_password2: 'different-123' })).status, 422);
  const ok = await chg({ current_password: 'first-pass-123', new_password: 'second-pass-123', new_password2: 'second-pass-123' });
  assert.equal(ok.status, 302); assert.equal(ok.headers.get('location'), '/account/password');
  assert.equal((await c.get('/account/password')).status, 200, 'still signed in after changing');
  assert.equal((await memberLogin(s.base, 'bob', 'first-pass-123')).r.status, 401);
  assert.equal((await memberLogin(s.base, 'bob', 'second-pass-123')).r.status, 302);
  assert.equal((await postAt(c, '/account/password', '/account', { name: 'Hacked Name' })).status, 403, 'admin-only site: members cannot edit their details');
});

test('admin resets a forgotten member password and can remove a member login (both sign the member out)', async (t) => {
  const s = await setup(); t.after(s.close);
  const m3 = s.ids[2];
  await setLogin(s, m3, { username: 'bob', password: 'first-pass-123' });
  const { c } = await memberLogin(s.base, 'bob', 'first-pass-123');
  assert.equal((await c.get('/account/password')).status, 200);
  const r = await postAt(s.admin, `/admin/members/${m3}`, `/admin/members/${m3}/password`, { password: 'reset-pass-123' });
  assert.equal(r.status, 302);
  assert.notEqual((await c.get('/account/password')).status, 200, 'old session signed out');
  assert.equal((await s.admin.get('/admin')).status, 200, 'admin stays signed in');
  assert.equal((await memberLogin(s.base, 'bob', 'first-pass-123')).r.status, 401);
  const again = await memberLogin(s.base, 'bob', 'reset-pass-123');
  assert.equal(again.r.status, 302);
  await postAt(s.admin, `/admin/members/${m3}`, `/admin/members/${m3}/login/remove`, {});
  assert.equal(user(s.db, m3).username, null);
  assert.notEqual((await again.c.get('/account/password')).status, 200);
  assert.equal((await memberLogin(s.base, 'bob', 'reset-pass-123')).r.status, 401);
});

test('normal (not admin-only) site: username login works alongside email logins and gets My account', async (t) => {
  const s = await setup({}); t.after(s.close);
  const m3 = s.ids[2];
  await setLogin(s, m3, { username: 'bob', password: 'first-pass-123' });
  const { c, r } = await memberLogin(s.base, 'bob', 'first-pass-123');
  assert.equal(r.status, 302);
  assert.equal((await c.get('/account')).status, 200);
  assert.equal((await c.get('/admin')).status, 403);
  const cap = new Client(s.base); assert.equal((await cap.login('p2@t.example')).status, 302, 'captain email login still works');
  // only admins can set member logins (a captain gets 403)
  assert.equal((await postAt(cap, '/account', `/admin/members/${s.ids[3]}/login`, { username: 'capset', password: 'captain-set-123' })).status, 403);
  assert.equal(user(s.db, s.ids[3]).username, null);
  assert.equal((await new Client(s.base).login('p4@t.example')).status, 302, 'member email login still works');
});
