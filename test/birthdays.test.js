'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { open, setSetting } = require('../src/db');
const { seedDemo } = require('../scripts/seed-demo-site');
const { startApp, Client } = require('./helpers');
const B = require('../src/lib/birthdays');

test('dob parsing: day/month with optional year', () => {
  assert.equal(B.parse('17 Oct'), '10-17'); assert.equal(B.parse('17 October'), '10-17'); assert.equal(B.parse('17/10'), '10-17');
  assert.equal(B.parse('17/10/1976'), '1976-10-17'); assert.equal(B.parse('1976-10-17'), '1976-10-17'); assert.equal(B.parse(''), null);
  assert.equal(B.parse('29 Feb'), '02-29'); assert.throws(() => B.parse('31/2')); assert.throws(() => B.parse('banana'));
  assert.equal(B.dayMonth('1976-10-17'), '17 October'); assert.equal(B.adminLabel('10-17'), '17 Oct');
});

test('London date and days-until', () => {
  assert.equal(B.londonToday(new Date('2026-10-16T23:30:00Z')), '2026-10-17', 'BST: 00:30 London is already the 17th');
  assert.equal(B.londonToday(new Date('2026-12-31T23:30:00Z')), '2026-12-31', 'GMT');
  assert.equal(B.daysUntil('10-17', '2026-10-17'), 0); assert.equal(B.daysUntil('10-18', '2026-10-17'), 1);
  assert.equal(B.daysUntil('10-16', '2026-10-17'), 364); assert.equal(B.daysUntil('02-29', '2027-02-20'), 8);
});

test('configs: birthdays on for Demo, off for starter', () => {
  assert.equal(JSON.parse(fs.readFileSync('sites/demo/site.config.json')).features.birthdays, true);
  assert.equal(JSON.parse(fs.readFileSync('sites/starter/site.config.json')).features.birthdays, false);
});

test('birthdays section retired from the public site; admin DOB edit and data kept', async () => {
  const db = open(':memory:'); seedDemo(db); setSetting(db, 'feature_birthdays', '1');
  const app = await startApp(db);
  try {
    const anon = new Client(app.base);
    const u = db.prepare("SELECT * FROM users WHERE status='active' AND role<>'admin' LIMIT 1").get();
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    const [, m, d] = B.londonToday().split('-');
    const base = { name: u.name, email: u.email, nickname: u.nickname || '', home_course: u.home_course || '', role: u.role, status: 'active', achievements: u.achievements || '', lowest_index: u.lowest_index ?? '' };
    assert.equal((await adm.post('/admin/members/' + u.id, { ...base, date_of_birth: 'nonsense' })).status, 422);
    assert.equal((await adm.post('/admin/members/' + u.id, { ...base, date_of_birth: `${+d}/${+m}/1970` })).status, 302);
    assert.equal(db.prepare('SELECT date_of_birth FROM users WHERE id=?').get(u.id).date_of_birth, `1970-${m}-${d}`, 'DOB still saved');
    assert.match((await adm.get('/admin/members/' + u.id)).text_, /1970/, 'admin still sees the DOB');
    // even with a birthday today and the flag on, nothing public shows it
    for (const flag of ['1', '0']) {
      setSetting(db, 'feature_birthdays', flag);
      const r = await anon.get('/birthdays'); assert.equal(r.status, 301); assert.equal(r.headers.get('location'), '/');
      const home = (await anon.get('/')).text_;
      assert.doesNotMatch(home, /href="\/birthdays"/); assert.doesNotMatch(home, /Happy birthday/i); assert.doesNotMatch(home, /bday-/);
      assert.doesNotMatch((await anon.get('/players/' + u.id)).text_, /1970/);
    }
  } finally { await app.close(); }
});
