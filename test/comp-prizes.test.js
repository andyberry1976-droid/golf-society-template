'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, setSetting, getSettings } = require('../src/db');
const CP = require('../src/lib/comp-prizes');
const { startApp, Client, miniSociety } = require('./helpers');
const users = require('../src/lib/users');

test('comp-prizes: parse, forComp, saveYear; empty by default', () => {
  const db = open(':memory:');
  assert.equal(CP.forYear({}, 2026), null);
  assert.equal(getSettings(db).comp_prize_fund || '', '', 'template default: no competition fund');
  setSetting(db, 'comp_prize_fund', JSON.stringify({ 2026: CP.DEFAULT_2026 }));
  const S = getSettings(db);
  const fund = CP.forYear(S, 2026);
  assert.ok(fund);
  assert.equal(fund.paid_subs, 33);
  assert.equal(fund.kitty_pence, 66000);
  const oom = CP.forComp(S, 2026, 'oom');
  assert.equal(oom.places[0].amount_pence, 15000);
  assert.equal(oom.total_pence, 26000);
  assert.equal(CP.forComp(S, 2025, 'oom'), null);
  assert.equal(CP.forComp(S, 2026, 'matchplay').places.length, 2);
  const parsed = CP.fromForm({
    paid_subs: '33', kitty: '660',
    oom_w1: '150', oom_w2: '70', oom_w3: '40',
    matchplay_w1: '120', matchplay_w2: '80',
    birdie_w1: '50', birdie_w2: '30', birdie_w3: '20',
    fedex_w1: '50', fedex_w2: '30', fedex_w3: '20',
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.comps.oom.total_pence, 26000);
});

test('comp-prizes: public pages show box when configured; admin can save', async () => {
  const { db, season } = miniSociety();
  // Ensure a 2026 season exists for the public pages
  const y = 2026;
  let s = db.prepare('SELECT id FROM seasons WHERE year=?').get(y);
  if (!s) {
    db.prepare("INSERT INTO seasons(name,year,start_date,end_date,status) VALUES (?,?,?,?,?)").run(String(y), y, `${y}-01-01`, `${y}-12-31`, 'open');
  }
  setSetting(db, 'comp_prize_fund', JSON.stringify({ 2026: CP.DEFAULT_2026 }));
  // matchplay needs a competition row for /matchplay to render
  const sid = db.prepare('SELECT id FROM seasons WHERE year=?').get(y).id;
  const hasMp = db.prepare('SELECT id FROM mp_comps WHERE season_id=?').get(sid);
  if (!hasMp) {
    db.prepare("INSERT INTO mp_comps(season_id,name,winner_cut) VALUES (?,?,0)").run(sid, `Matchplay ${y}`);
  }
  const app = await startApp(db);
  try {
    const anon = new Client(app.base);
    for (const path of ['/standings', '/birdie-league', '/fedex', '/matchplay']) {
      const r = await anon.get(path.includes('standings') || path.includes('birdie') || path.includes('fedex')
        ? `${path}?season=${sid}`
        : path);
      assert.equal(r.status, 200, path);
      assert.match(r.text_, /Prize money 2026/, path);
      assert.match(r.text_, /class="cpz"/, path);
    }
    const r = await anon.get('/prize-money');
    assert.equal(r.status, 200);
    assert.match(r.text_, /Competition prize fund 2026/);
    assert.match(r.text_, /33 players paid subs/);
    assert.match(r.text_, /£660/);

    const id = users.createUser(db, { name: 'Fund Admin', email: 'fund-admin@t.example', passwordHash: users.hashPassword('password-123'), index: 18, joinedOn: '2025-01-01' });
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(id);
    const adm = new Client(app.base);
    await adm.login('fund-admin@t.example');
    let a = await adm.get('/admin/prizes?year=2026');
    assert.equal(a.status, 200);
    assert.match(a.text_, /Competition prize fund 2026/);
    const post = await adm.post('/admin/prizes/comp-fund', {
      year: '2026', paid_subs: '33', kitty: '660',
      oom_w1: '150', oom_w2: '70', oom_w3: '40',
      matchplay_w1: '120', matchplay_w2: '80',
      birdie_w1: '50', birdie_w2: '30', birdie_w3: '20',
      fedex_w1: '55', fedex_w2: '30', fedex_w3: '15',
    });
    assert.equal(post.status, 302);
    const S = getSettings(db);
    assert.equal(CP.forComp(S, 2026, 'fedex').places[0].amount_pence, 5500);
  } finally { await app.close(); }
});
