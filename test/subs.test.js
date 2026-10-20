'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { open } = require('../src/db');
const { startApp, Client } = require('./helpers');
const Subs = require('../src/lib/subs');
const L = require('../sites/demo/seed/subs-2026');

const seeded = () => { const db = open(':memory:'); require('../scripts/seed-demo-site').seedDemo(db); return db; };
const S26 = (db) => db.prepare("SELECT id FROM seasons WHERE name='2026'").get().id;
const uid = (db, n) => db.prepare('SELECT id FROM users WHERE name=?').get(n).id;

test('the WhatsApp list matches real members; applying is idempotent and leaves others alone', () => {
  const db = seeded(); const s = S26(db);
  const names = new Set(db.prepare('SELECT name FROM users').all().map((u) => u.name));
  for (const e of L.LIST) assert.ok(names.has(e.member), e.member);
  assert.equal(new Set(L.LIST.map((e) => e.member)).size, L.LIST.length, 'no member twice');
  assert.equal(L.LIST.filter((e) => e.paid).length, 24); assert.equal(L.LIST.filter((e) => !e.paid).length, 8);
  Subs.set(db, s, uid(db, 'Player 8'), { paid: true, note: 'cash' });
  const a = Subs.applyList(db, s, L.entries());
  assert.equal(a.changed.length, 32); assert.deepEqual(a.missing, []);
  const b = Subs.applyList(db, s, L.entries());
  assert.equal(b.changed.length, 0); assert.equal(b.unchanged.length, 32);
  assert.equal(Subs.get(db, s, uid(db, 'Player 8')).note, 'cash', 'not on the list: untouched');
  assert.equal(db.prepare('SELECT subs_paid FROM users WHERE name=?').get('Player 4').subs_paid, 1, 'mirrors current season');
  assert.match(Subs.get(db, s, uid(db, 'Player 4')).note, /faded/);
  assert.equal(Subs.get(db, s, uid(db, 'Player 1')).paid, 0);
  const k = Subs.counts(Subs.list(db, s)); assert.equal(k.paid, 25);
  // a hand-entered date/amount survives re-applying
  Subs.set(db, s, uid(db, 'Player 17'), { paid: true, paid_on: '2026-03-01', amount: 20, note: 'bank' });
  Subs.applyList(db, s, L.entries());
  assert.deepEqual([Subs.get(db, s, uid(db, 'Player 17')).paid_on, Subs.get(db, s, uid(db, 'Player 17')).amount], ['2026-03-01', 20]);
});

test('HTTP: staff page, toggle + edit with audit, filters, Excel; members only see their own', async () => {
  const db = seeded(); const app = await startApp(db);
  try {
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    let p = await adm.get('/admin/subs'); assert.equal(p.status, 200); assert.match(p.text_, /Subs 2026/); assert.match(p.text_, /Apply the WhatsApp list/);
    assert.match((await adm.get('/admin')).text_, /href="\/admin\/subs"/);
    assert.equal((await adm.post('/admin/subs/apply-list', {})).status, 302);
    p = await adm.get('/admin/subs'); assert.match(p.text_, /24 paid/);
    assert.equal((await adm.get('/admin/subs?show=unpaid')).text_.match(/✗ Unpaid/g).length, Subs.counts(Subs.list(db, S26(db))).unpaid);
    const ben = uid(db, 'Player 1');
    assert.equal((await adm.post(`/admin/subs/${ben}`, { season_id: S26(db), toggle: '1' })).status, 302);
    assert.equal(Subs.get(db, S26(db), ben).paid, 1); assert.ok(Subs.get(db, S26(db), ben).paid_on);
    await adm.post(`/admin/subs/${ben}`, { season_id: S26(db), paid: '1', paid_on: '2026-04-02', amount: '20', note: 'paid at Silverbrook' });
    assert.deepEqual([Subs.get(db, S26(db), ben).amount, Subs.get(db, S26(db), ben).note], [20, 'paid at Silverbrook']);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='subs_set' AND detail LIKE '%Player 1%'").get().n >= 2);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='subs_apply_list'").get().n === 1);
    const r = await fetch(app.base + '/admin/subs.xlsx', { headers: { cookie: adm._cookieHeader() } });
    assert.equal(r.status, 200);
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
    const ws = wb.worksheets[0]; let found = false; ws.eachRow((row) => { if (row.getCell(1).value === 'Player 1') { found = true; assert.equal(row.getCell(4).value, 'Yes'); assert.equal(row.getCell(6).value, 20); } });
    assert.ok(found);
    const cap = new Client(app.base); await cap.login('captain@example.test', 'flamingo-demo-1');
    const cp = await cap.get('/admin/subs'); assert.equal(cp.status, 200); assert.doesNotMatch(cp.text_, /Apply the WhatsApp list/);
    assert.equal((await cap.post('/admin/subs/apply-list', {})).status, 403);
    const mem = new Client(app.base); await mem.login('member@example.test', 'flamingo-demo-1');
    assert.equal((await mem.get('/admin/subs')).status, 403);
    assert.equal((await fetch(app.base + '/admin/subs.xlsx', { headers: { cookie: mem._cookieHeader() } })).status, 403);
    const acc = await mem.get('/account'); assert.match(acc.text_, /My subs \(2026\)/); assert.doesNotMatch(acc.text_, /Player 1/);
  } finally { await app.close(); }
});

test('feature flag off hides Subs', async () => {
  const db = seeded(); db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES ('feature_subs','0')").run();
  const app = await startApp(db);
  try {
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    assert.equal((await adm.get('/admin/subs')).status, 404);
    assert.doesNotMatch((await adm.get('/admin')).text_, /href="\/admin\/subs"/);
    assert.doesNotMatch((await adm.get('/account')).text_, /My subs/);
  } finally { await app.close(); }
});
