'use strict';
process.env.BCRYPT_ROUNDS = '4';
process.env.NODE_ENV = process.env.NODE_ENV === 'production' ? 'test' : (process.env.NODE_ENV || 'test');
const { open } = require('../src/db');
const { load } = require('../src/config');
const { createApp } = require('../src/app');
const users = require('../src/lib/users');
const { seedBase } = require('../src/lib/baseline');
const { recomputeAll } = require('../src/lib/engine');

function memDb() {
  const db = open(':memory:');
  // the original tests exercise the WHS-style engine and position-points OoM; society-mode tests opt in
  const { setSetting } = require('../src/db');
  setSetting(db, 'handicap_mode', 'whs');
  setSetting(db, 'oom_default_scheme', JSON.stringify({ positions: [30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1], participation: 5, bestN: null }));
  seedBase(db, { year: 2026 });
  return db;
}

/** Minimal society: 1 course, season 2026, N members (indexes given). */
function miniSociety(indexes = [10, 15, 20, 25]) {
  const db = memDb();
  db.prepare('DELETE FROM seasons').run();
  const season = db.prepare("INSERT INTO seasons(name,year,start_date,end_date) VALUES ('2026',2026,'2026-01-01','2026-12-31')").run().lastInsertRowid;
  const course = db.prepare("INSERT INTO courses(name,tee,par,rating,slope) VALUES ('Test Links','Yellow',72,71.0,130)").run().lastInsertRowid;
  const ids = indexes.map((ix, i) => users.createUser(db, { name: `Player ${i + 1}`, email: `p${i + 1}@t.example`, passwordHash: users.hashPassword('password-123'), index: ix, joinedOn: '2025-01-01' }));
  return { db, season, course, ids };
}

function addEvent(db, { season, course, title = 'Event', date = '2026-05-02', format = 'stableford', basis = 'stableford', capacity = null, hcp = 1, mult = 1, oom = 1, status = 'scheduled', cat = null }) {
  return db.prepare(`INSERT INTO events(season_id,title,course_id,event_date,format,scoring_basis,capacity,counts_handicap,counts_oom,points_multiplier,status,honour_category_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(season, title, course, date, format, basis, capacity, hcp, oom, mult, status, cat).lastInsertRowid;
}

function testConfig(over = {}) {
  return { ...load({ NODE_ENV: 'test', SESSION_SECRET: 'test-secret' }), loginLimit: { windowMs: 60000, limit: 1000 }, joinLimit: { windowMs: 60000, limit: 1000 }, adminLoginOnly: false, ...over }; // role tests need member logins; admin-only sign-in has its own test
}

/** Start the app on an ephemeral port; returns {base, close, db} plus a cookie-jar fetch helper. */
async function startApp(db, over = {}) {
  const config = testConfig(over);
  const app = createApp({ db, config });
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const close = () => new Promise((r) => { app.locals.sessionStore.close(); server.close(r); });
  return { base, close, db, app };
}

class Client {
  constructor(base) { this.base = base; this.cookies = {}; }
  _cookieHeader() { return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; '); }
  async req(method, path, { form, headers = {} } = {}) {
    const opts = { method, redirect: 'manual', headers: { ...headers } };
    const ck = this._cookieHeader(); if (ck) opts.headers.cookie = ck;
    if (form) { opts.headers['content-type'] = 'application/x-www-form-urlencoded'; opts.body = new URLSearchParams(form).toString(); }
    const res = await fetch(this.base + path, opts);
    for (const c of res.headers.getSetCookie ? res.headers.getSetCookie() : []) {
      const [pair] = c.split(';'); const i = pair.indexOf('='); const k = pair.slice(0, i); const v = pair.slice(i + 1);
      if (/expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[k]; else this.cookies[k] = v;
    }
    res.text_ = await res.text();
    return res;
  }
  get(path) { return this.req('GET', path); }
  async csrf() {
    const r = await this.get(this.loggedIn ? '/account' : '/login');
    const m = r.text_.match(/name="_csrf" value="([^"]+)"/);
    return m && m[1];
  }
  /** POST a form with a valid CSRF token (fetched automatically). */
  async post(path, form = {}) {
    const token = await this.csrf();
    return this.req('POST', path, { form: { _csrf: token || '', ...form } });
  }
  async login(email, password = 'password-123') {
    const token = await this.csrf();
    const r = await this.req('POST', '/login', { form: { _csrf: token, email, password } });
    this.loggedIn = r.status === 302;
    return r;
  }
}

module.exports = { memDb, miniSociety, addEvent, startApp, Client, testConfig, recomputeAll };
