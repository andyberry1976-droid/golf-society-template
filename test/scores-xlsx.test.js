'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { open } = require('../src/db');
const { startApp, Client } = require('./helpers');
const SX = require('../src/lib/scores-xlsx');

const seeded = () => { const db = open(':memory:'); require('../scripts/seed-demo-site').seedDemo(db); return db; };
const snap = (db) => JSON.stringify([db.prepare('SELECT event_id,user_id,gross,stableford,stableford_in,hcp_played,note FROM results ORDER BY event_id,user_id').all(), db.prepare('SELECT * FROM event_players ORDER BY event_id,user_id').all().map(({ created_at, added_at, ...r }) => r), db.prepare('SELECT comp,event_id,user_id,value FROM comp_scores ORDER BY 1,2,3').all()]);
async function download(c, path) { const r = await fetch(c.base + path, { headers: { cookie: c._cookieHeader() } }); return { status: r.status, type: r.headers.get('content-type'), buf: Buffer.from(await r.arrayBuffer()) }; }
async function upload(c, buf) {
  const fd = new FormData(); fd.append('_csrf', await c.csrf()); fd.append('file', new Blob([buf]), 'scores.xlsx');
  const r = await fetch(c.base + '/admin/scores/import', { method: 'POST', body: fd, headers: { cookie: c._cookieHeader() }, redirect: 'manual' });
  return { status: r.status, text_: await r.text() };
}
const tokenOf = (h) => (h.match(/name="token" value="([a-f0-9]+)"/) || [])[1];
async function edit(buf, fn) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Scores'); const col = {}; ws.getRow(1).eachCell((c, i) => { col[String(c.value)] = i; });
  fn(ws, col); return Buffer.from(await wb.xlsx.writeBuffer());
}
const firstEmpty = (ws, col) => { for (let r = 2; r <= ws.rowCount; r++) if (!ws.getRow(r).getCell(col.Player).value) return r; return ws.rowCount + 1; };
const pickEvent = (db) => db.prepare("SELECT e.id FROM events e WHERE e.status='completed' AND EXISTS (SELECT 1 FROM results r WHERE r.event_id=e.id) ORDER BY e.event_date DESC LIMIT 1").get().id;
const outsider = (db, ev) => db.prepare("SELECT id,name FROM users WHERE status='active' AND role!='admin' AND id NOT IN (SELECT user_id FROM event_players WHERE event_id=?) AND id NOT IN (SELECT user_id FROM results WHERE event_id=?) ORDER BY id LIMIT 1").get(ev, ev);

test('round trip: every season and a single event re-import as unchanged; blank template has no rows', async () => {
  const db = seeded();
  for (const o of [...db.prepare('SELECT id FROM seasons s WHERE EXISTS (SELECT 1 FROM events e WHERE e.season_id=s.id)').all().map((s) => ({ seasonId: s.id })), { eventId: pickEvent(db) }]) {
    const p = SX.plan(db, await SX.readWorkbook(await SX.exportWorkbook(db, o)));
    assert.equal(p.counts.changed + p.counts.new + p.counts.error, 0, JSON.stringify(o));
    assert.ok(p.counts.unchanged > 0);
  }
  assert.equal((await SX.readWorkbook(await SX.exportWorkbook(db, { eventId: pickEvent(db), blank: true }))).rows.length, 0);
  const before = snap(db); SX.applyPlan(db, SX.plan(db, await SX.readWorkbook(await SX.exportWorkbook(db, { seasonId: 1 }))), {}); assert.equal(snap(db), before);
});

test('plan: unknown player gets suggestions; bad numbers and bad event id are errors; nickname matches', async () => {
  const db = seeded(); const ev = pickEvent(db);
  const buf = await edit(await SX.exportWorkbook(db, { eventId: ev }), (ws, col) => {
    const r = firstEmpty(ws, col);
    ws.getRow(r).getCell(col.Player).value = 'Layer 8'; ws.getRow(r).getCell(col.Gross).value = 90;
    ws.getRow(r + 1).getCell(col.Player).value = ws.getRow(2).getCell(col.Player).value; ws.getRow(r + 1).getCell(col['Event ID']).value = 99999; ws.getRow(r + 1).getCell(col.Gross).value = 90;
    ws.getRow(2).getCell(col.Gross).value = 'abc';
  });
  const p = SX.plan(db, await SX.readWorkbook(buf));
  const errs = p.rows.filter((r) => r.kind === 'error').map((r) => r.errors.join(' '));
  assert.equal(errs.length, 3, errs.join('|'));
  assert.ok(errs.some((e) => /Layer 8/.test(e) && /Player 8/.test(e)));
  assert.ok(errs.some((e) => /event/i.test(e)));
  assert.ok(errs.some((e) => /Gross/.test(e)));
  const nick = db.prepare("SELECT nickname,name FROM users WHERE status='active' AND nickname IS NOT NULL AND nickname!='' LIMIT 1").get();
  if (nick) { const p2 = SX.plan(db, { rows: [{ rowNo: 2, raw: { event_id: ev, player: nick.nickname } }] }); assert.notEqual(p2.rows[0].kind, 'error', JSON.stringify(p2.rows[0])); }
});

test('HTTP: export → add a player + edit a score → preview → confirm; field, results, standings, audit; nothing removed', async () => {
  const db = seeded(); const app = await startApp(db);
  try {
    const cap = new Client(app.base); await cap.login('admin@example.test', 'flamingo-demo-1');
    const ev = pickEvent(db); const who = outsider(db, ev);
    const page = (await cap.get(`/events/${ev}`)).text_;
    assert.match(page, new RegExp(`/admin/events/${ev}/scores.xlsx`)); assert.match(page, /Import players &amp; scores/);
    assert.match((await cap.get(`/admin/events/${ev}/results`)).text_, /Export players &amp; scores/);
    assert.match((await cap.get(`/admin/events/${ev}/edit`)).text_, /Import players &amp; scores/);
    assert.match((await cap.get('/admin/events')).text_, /Import players &amp; scores/);
    const dl = await download(cap, `/admin/events/${ev}/scores.xlsx`); assert.equal(dl.status, 200); assert.match(dl.type, /spreadsheetml/);
    assert.equal((await download(cap, '/admin/scores.xlsx?season=1')).status, 200);
    let edited;
    const buf = await edit(dl.buf, (ws, col) => {
      ws.spliceRows(3, 1); // drop a row: must NOT remove that player
      const g = ws.getRow(2).getCell(col.Gross); edited = { name: String(ws.getRow(2).getCell(col.Player).value) }; g.value = 77;
      const r = firstEmpty(ws, col); ws.getRow(r).getCell(col.Player).value = who.name; ws.getRow(r).getCell(col['Stableford points']).value = 41; ws.getRow(r).getCell(col.Notes).value = 'added via Excel';
    });
    const fieldBefore = db.prepare('SELECT COUNT(*) n FROM event_players WHERE event_id=?').get(ev).n;
    const resBefore = db.prepare('SELECT COUNT(*) n FROM results WHERE event_id=?').get(ev).n;
    const up = await upload(cap, buf); assert.equal(up.status, 200, up.text_.slice(0, 400));
    assert.match(up.text_, /1 new to the field/); assert.match(up.text_, /1 changed/); assert.match(up.text_, /0 with errors/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM results WHERE event_id=?').get(ev).n, resBefore, 'preview saves nothing');
    const r = await cap.post('/admin/scores/import/confirm', { token: tokenOf(up.text_) }); assert.equal(r.status, 302);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM event_players WHERE event_id=?').get(ev).n, fieldBefore + 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM results WHERE event_id=?').get(ev).n, resBefore + 1);
    const nr = db.prepare('SELECT * FROM results WHERE event_id=? AND user_id=?').get(ev, who.id);
    assert.equal(nr.stableford_in, 41); assert.equal(nr.note, 'added via Excel'); assert.ok(nr.position != null, 'standings recalculated');
    const er = db.prepare('SELECT r.gross FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND (u.name=? OR u.nickname=?)').get(ev, edited.name, edited.name);
    assert.equal(er.gross, 77);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='scores_import'").get().n === 1);
    assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='import_score'").get().n >= 2);
    assert.equal((await cap.post('/admin/scores/import/confirm', { token: tokenOf(up.text_) })).status, 302); // expired token: no double apply
    assert.equal(db.prepare('SELECT COUNT(*) n FROM results WHERE event_id=?').get(ev).n, resBefore + 1);
  } finally { await app.close(); }
});

test('HTTP: errors block the import; members get 403', async () => {
  const db = seeded(); const app = await startApp(db);
  try {
    const cap = new Client(app.base); await cap.login('admin@example.test', 'flamingo-demo-1');
    const ev = pickEvent(db);
    const buf = await edit((await download(cap, `/admin/events/${ev}/scores.xlsx`)).buf, (ws, col) => { const r = firstEmpty(ws, col); ws.getRow(r).getCell(col.Player).value = 'Player 73'; ws.getRow(r).getCell(col.Gross).value = 88; });
    const before = snap(db); const up = await upload(cap, buf);
    assert.match(up.text_, /1 with errors/); assert.doesNotMatch(up.text_, /Confirm &amp; save/);
    assert.equal((await cap.post('/admin/scores/import/confirm', { token: tokenOf(up.text_) })).status, 422);
    assert.equal(snap(db), before);
    assert.equal((await upload(cap, Buffer.from('not a spreadsheet'))).status, 422);
    const mem = new Client(app.base); await mem.login('member@example.test', 'flamingo-demo-1');
    assert.equal((await download(mem, `/admin/events/${ev}/scores.xlsx`)).status, 403);
    assert.equal((await mem.get('/admin/scores/import')).status, 403);
    assert.doesNotMatch((await mem.get(`/events/${ev}`)).text_, /scores\.xlsx/);
  } finally { await app.close(); }
});
