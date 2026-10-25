'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setSetting } = require('../src/db');
const { miniSociety, startApp, Client } = require('./helpers');

test('Ryder Cup: year dropdown lists every cup, defaults to the latest, ?year= picks one', async () => {
  const { db, ids } = miniSociety([10, 12, 14, 16]);
  setSetting(db, 'feature_ryder', '1');
  const cup = db.prepare('INSERT INTO ryder_cups(year,name,team_a,team_b,captain_a_id,captain_b_id,score_a,score_b) VALUES (?,?,?,?,?,?,?,?)');
  const pl = db.prepare('INSERT INTO ryder_players(cup_id,user_id,team) VALUES (?,?,?)');
  const mt = db.prepare('INSERT INTO ryder_matches(cup_id,session_no,session_name,match_no,a_ids,b_ids,winner,result) VALUES (?,?,?,?,?,?,?,?)');
  const c1 = cup.run(2024, 'Cup 2024', 'Team Reds', 'Team Blues', ids[0], ids[2], 1.5, 0.5).lastInsertRowid;
  const c2 = cup.run(2025, 'Cup 2025', 'Team Greens', 'Team Golds', ids[1], ids[3], 0.5, 1.5).lastInsertRowid;
  for (const c of [c1, c2]) { pl.run(c, ids[0], 'A'); pl.run(c, ids[1], 'A'); pl.run(c, ids[2], 'B'); pl.run(c, ids[3], 'B'); }
  mt.run(c1, 1, 'Four Ball', 1, `${ids[0]},${ids[1]}`, `${ids[2]},${ids[3]}`, 'A', '3&2');
  mt.run(c1, 2, 'Singles', 1, `${ids[0]}`, `${ids[2]}`, 'H', 'A/S');
  mt.run(c2, 1, 'Four Ball', 1, `${ids[0]},${ids[1]}`, `${ids[2]},${ids[3]}`, 'B', '1 up');
  mt.run(c2, 2, 'Singles', 1, `${ids[1]}`, `${ids[3]}`, 'H', 'A/S');
  const app = await startApp(db);
  try {
    const c = new Client(app.base);
    const t = (await c.get('/ryder-cup')).text_;
    const opts = [...t.matchAll(/<option value="(\d{4})"( selected)?/g)].map((m) => m[1] + (m[2] ? '*' : ''));
    assert.deepEqual(opts, ['2025*', '2024']);
    assert.match(t, /Cup 2025/); assert.doesNotMatch(t, /Cup 2024<\/h2>/);
    assert.match(t, /class="rc-m wb"/); assert.match(t, /<b>1 UP<\/b>/); assert.match(t, /Golds win/); assert.match(t, /running ½–1½/);
    assert.match(t, /Player 1 &amp; Player 2/, 'full pair names');
    const t4 = (await c.get('/ryder-cup?year=2024')).text_;
    assert.match(t4, /<option value="2024" selected/); assert.match(t4, /Cup 2024/); assert.doesNotMatch(t4, /Cup 2025<\/h2>/);
    assert.match(t4, /<b>3&amp;2<\/b>/); assert.match(t4, /<b>Halved<\/b>/); assert.match(t4, /session 1–0 · running 1–0/); assert.match(t4, /running 1½–½/);
    assert.match(t4, /class="card rcup ta-red tb-blue"/, 'Reds/Blues colours'); assert.doesNotMatch(t, /ta-red|tb-blue/);
    // a cup without named captains shows no captains line
    db.prepare('UPDATE ryder_cups SET captain_a_id=NULL, captain_b_id=NULL WHERE id=?').run(c1);
    const nc = (await c.get('/ryder-cup?year=2024')).text_; assert.doesNotMatch(nc, /Captains:/); assert.doesNotMatch(nc, /\(captain\)/); assert.match(nc, /Team Reds won\./);
    for (const q of ['?year=1999', '?year=abc']) { const r = await c.get('/ryder-cup' + q); assert.equal(r.status, 200); assert.match(r.text_, /<option value="2025" selected/); }
    db.prepare('DELETE FROM ryder_cups').run();
    const e = await c.get('/ryder-cup'); assert.equal(e.status, 200); assert.match(e.text_, /No Ryder Cups on record yet/); assert.doesNotMatch(e.text_, /id="rc-year"/);
  } finally { await app.close(); }
});
