'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { open } = require('../src/db'); const { createApp } = require('../src/app'); const { ensureAdmin } = require('../src/bootstrap'); const { seedDemo } = require('../scripts/seed-demo'); const { computeEvent, league } = require('../src/lib/compute');

test('first start: production refuses missing/demo passwords; dev makes a random one', () => {
  assert.throws(() => ensureAdmin(open(), { NODE_ENV: 'production' }));
  assert.throws(() => ensureAdmin(open(), { NODE_ENV: 'production', ADMIN_EMAIL: 'a@b.c', ADMIN_PASSWORD: 'flamingo-demo-1' }));
  let said = ''; ensureAdmin(open(), {}, (m) => { said = m; }); assert.match(said, /one-time password: \S{12}/);
});

test('demo seed: no real society data, results stored with config snapshot, league table', () => {
  const db = open(); seedDemo(db);
  const r = db.prepare('SELECT * FROM results').all(); assert.equal(r.length, 16);
  assert.ok(r.every((x) => JSON.parse(x.config_snapshot).format));
  const scr = db.prepare("SELECT r.* FROM results r JOIN events e ON e.id=r.event_id WHERE e.title='Summer Scramble' ORDER BY position").all();
  assert.equal(scr[0].position, 1); assert.equal(scr.filter((x) => x.position === 1).length, 4); // a whole team shares the win
  const L = league(db, 1); assert.equal(L.rows.length, 8); assert.ok(L.rows[0].total >= L.rows[7].total);
  assert.throws(() => seedDemo(db));
  // editing the competition type later does not rewrite stored results
  db.prepare("UPDATE competition_types SET config=json_set(config,'$.points.positions',json('[1]'))").run();
  assert.deepEqual(db.prepare('SELECT points FROM results ORDER BY id').all(), r.map((x) => ({ points: x.points })));
});

test('matchplay and better-ball from hole-by-hole cards', () => {
  const db = open(); seedDemo(db);
  const P = require('../src/lib/scoring/presets');
  const mp = db.prepare("SELECT id FROM competition_types WHERE name='Matchplay'").get().id;
  const ev = db.prepare("INSERT INTO events(title,event_date,course_id,competition_type_id) VALUES ('MP','2026-07-01',1,?)").run(mp).lastInsertRowid;
  const pars = JSON.parse(db.prepare('SELECT holes FROM courses').get().holes).map((h) => h.par);
  db.prepare('INSERT INTO scores(event_id,member_id,team_no,hcp_index,holes) VALUES (?,1,1,0,?)').run(ev, JSON.stringify(pars.map((p) => p - 1)));
  db.prepare('INSERT INTO scores(event_id,member_id,team_no,hcp_index,holes) VALUES (?,2,1,0,?)').run(ev, JSON.stringify(pars));
  computeEvent(db, ev);
  assert.deepEqual(db.prepare('SELECT member_id, position, detail FROM results WHERE event_id=? ORDER BY member_id').all(ev).map((x) => [x.position, x.detail]), [[1, 'Won 10&8'], [2, 'Lost 10&8']]);
  const bb = db.prepare('INSERT INTO competition_types(name,config) VALUES (?,?)').run('Pairs', JSON.stringify(P.normalise({ ...P.PRESETS.better_ball, preset: 'better_ball' }))).lastInsertRowid;
  const ev2 = db.prepare("INSERT INTO events(title,event_date,course_id,competition_type_id) VALUES ('BB','2026-07-02',1,?)").run(bb).lastInsertRowid;
  for (const [m, t] of [[1, 1], [2, 1], [3, 2], [4, 2]]) db.prepare('INSERT INTO scores(event_id,member_id,team_no,hcp_index,holes) VALUES (?,?,?,0,?)').run(ev2, m, t, JSON.stringify(pars.map((p) => p + (m === 1 ? 0 : 1))));
  computeEvent(db, ev2);
  // index 0 on a 71.2/72 course plays off +1, so one point is given back
  const res = db.prepare('SELECT member_id, stableford, position FROM results WHERE event_id=? ORDER BY member_id').all(ev2);
  assert.deepEqual(res.map((x) => [x.stableford, x.position]), [[35, 1], [35, 1], [17, 2], [17, 2]]);
});

async function client(app) {
  const srv = app.listen(0); const base = `http://127.0.0.1:${srv.address().port}`; let cookie = '';
  const req = async (method, p, form) => { const r = await fetch(base + p, { method, redirect: 'manual', headers: { cookie, ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) }, body: form ? new URLSearchParams(form).toString() : undefined });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0]; r.text_ = await r.text(); return r; };
  return { req, close: () => srv.close() };
}

test('HTTP: public pages, admin flow (type -> event -> scores -> results -> league), CSRF + auth enforced', async () => {
  const db = open(); seedDemo(db); ensureAdmin(db, { ADMIN_EMAIL: 'admin2@example.test', ADMIN_PASSWORD: 'a-unique-pass-123' });
  const c = await client(createApp(db));
  try {
    assert.match((await c.req('GET', '/')).text_, /Demo Golf Society/);
    assert.equal((await c.req('GET', '/events/1')).status, 200); assert.equal((await c.req('GET', '/leagues/1')).status, 200);
    assert.equal((await c.req('GET', '/admin')).status, 302);
    assert.equal((await c.req('POST', '/login', { email: 'admin2@example.test', password: 'nope' })).status, 401);
    assert.equal((await c.req('POST', '/login', { email: 'admin2@example.test', password: 'a-unique-pass-123' })).status, 302);
    const page = await c.req('GET', '/admin?preset=par_bogey'); assert.equal(page.status, 200); const csrf = page.text_.match(/name="_csrf" value="([a-f0-9]+)"/)[1];
    assert.equal((await c.req('POST', '/admin/types', { name: 'X', preset: 'stableford' })).status, 403);
    await c.req('POST', '/admin/types', { _csrf: csrf, name: 'Par Bogey Cup', preset: 'par_bogey', format: 'par_bogey', allowance_pct: '90', positions: '10,6,4', bonus_last: '-5', countback: '1' });
    const t = db.prepare("SELECT id FROM competition_types WHERE name='Par Bogey Cup'").get().id;
    const e = await c.req('POST', '/admin/events', { _csrf: csrf, title: 'Bogey Day', event_date: '2026-08-08', course_id: '1', competition_type_id: String(t) });
    const ev = e.headers.get('location').split('/').pop();
    assert.equal((await c.req('GET', `/admin/events/${ev}`)).status, 200);
    const h = (n) => Array(18).fill(n).join(',');
    const s = await c.req('POST', `/admin/events/${ev}/scores`, { _csrf: csrf, holes_1: h(4), holes_2: h(5), gross_3: '90', stableford_4: '30' });
    assert.equal(s.status, 302);
    const out = db.prepare('SELECT member_id, position, points, par_bogey FROM results WHERE event_id=? ORDER BY member_id').all(ev);
    assert.equal(out.length, 4); assert.equal(out[0].position, 1);
    assert.match((await c.req('POST', `/admin/events/${ev}/scores`, { _csrf: csrf, holes_1: '4,4' })).headers.get('location'), /error=/);
    await c.req('POST', '/admin/settings', { _csrf: csrf, name: 'Fairway Friends', primary: '#123456', accent: 'nothex' });
    const home = (await c.req('GET', '/')).text_; assert.match(home, /Fairway Friends/); assert.match(home, /--primary:#123456/);
    await c.req('POST', '/admin/leagues', { _csrf: csrf, name: 'Bogey League', types: String(t), bestN: '3' });
    const L = db.prepare("SELECT id FROM leagues WHERE name='Bogey League'").get().id; assert.match((await c.req('GET', `/leagues/${L}`)).text_, /1 event/);
  } finally { c.close(); }
});
