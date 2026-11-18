'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const { open } = require('../src/db');
const { startApp, Client, seedDemoPlusEvents } = require('./helpers');
const XL = require('../src/lib/events-xlsx');
const { parse } = require('../src/lib/multipart');

const seeded = () => seedDemoPlusEvents().db;
const snapshot = (db) => JSON.stringify(db.prepare('SELECT * FROM events ORDER BY id').all().map(({ created_at, ...e }) => e));

async function download(c, path) {
  const opts = { headers: { cookie: c._cookieHeader() } };
  const r = await fetch(c.base + path, opts);
  return { status: r.status, type: r.headers.get('content-type'), disp: r.headers.get('content-disposition'), buf: Buffer.from(await r.arrayBuffer()) };
}
async function upload(c, buf, name = 'events.xlsx') {
  const token = await c.csrf();
  const fd = new FormData();
  fd.append('_csrf', token);
  fd.append('file', new Blob([buf]), name);
  const r = await fetch(c.base + '/admin/events/import', { method: 'POST', body: fd, headers: { cookie: c._cookieHeader() }, redirect: 'manual' });
  return { status: r.status, text_: await r.text() };
}
const tokenOf = (html) => (html.match(/name="token" value="([a-f0-9]+)"/) || [])[1];
async function edit(buf, fn) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  const ws = wb.getWorksheet('Events');
  const col = {}; ws.getRow(1).eachCell((c, i) => { col[String(c.value)] = i; });
  fn(ws, col);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

test('multipart parser reads fields and a binary file', () => {
  const b = '----x1';
  const body = Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="_csrf"\r\n\r\nabc\r\n--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`), Buffer.from([0, 1, 2, 13, 10, 255]), Buffer.from(`\r\n--${b}--\r\n`)]);
  const p = parse(body, `multipart/form-data; boundary=${b}`);
  assert.equal(p.fields._csrf, 'abc');
  assert.deepEqual([...p.files.file.data], [0, 1, 2, 13, 10, 255]);
  assert.equal(p.files.file.filename, 'a.xlsx');
});

test('export: sheets, hidden locked ID, UK dates, dropdowns, Y/N only for enabled modules', async () => {
  const db = seeded();
  const buf = await XL.exportWorkbook(db, { on: { birdie: true, fedex: false, oom: true, majors: true }, hcpFixed: true });
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Events', 'Instructions', 'Lists']);
  const ws = wb.getWorksheet('Events');
  const heads = []; ws.getRow(1).eachCell((c) => heads.push(String(c.value)));
  assert.ok(heads.includes('Birdie League (Y/N)') && !heads.includes('FedEx Cup (Y/N)') && !heads.includes('Counts for handicap (Y/N)'));
  assert.equal(ws.getColumn(1).hidden, true);
  assert.equal(ws.getCell('A2').protection ? ws.getCell('A2').protection.locked !== false : true, true);
  assert.equal(ws.getCell('D2').protection.locked, false);
  assert.equal(ws.getCell('B2').numFmt, 'dd/mm/yyyy');
  assert.equal(ws.getCell(`${ws.getColumn(heads.indexOf('Course') + 1).letter}2`).dataValidation.type, 'list');
  assert.equal(ws.rowCount >= db.prepare('SELECT COUNT(*) n FROM events').get().n + 1, true);
  const blank = await XL.exportWorkbook(db, { blank: true });
  assert.equal((await XL.readWorkbook(blank)).rows.length, 0);
});

test('round trip with no edits: every row unchanged, nothing saved', async () => {
  const db = seeded();
  const before = snapshot(db);
  const s = await XL.readWorkbook(await XL.exportWorkbook(db));
  const p = XL.plan(db, s);
  assert.deepEqual(p.counts, { new: 0, changed: 0, unchanged: db.prepare('SELECT COUNT(*) n FROM events').get().n, error: 0 });
  assert.equal(snapshot(db), before);
});

test('HTTP: export → edit + new row → preview → confirm; audited; omitted rows not deleted', async () => {
  const db = seeded();
  const app = await startApp(db);
  try {
    const cap = new Client(app.base); await cap.login('admin@example.test', 'flamingo-demo-1');
    const S26 = db.prepare("SELECT id FROM seasons WHERE name='2026'").get().id;
    assert.match((await cap.get('/admin/events')).text_, /Export to Excel/);
    const dl = await download(cap, `/admin/events/export.xlsx?season=${S26}`);
    assert.equal(dl.status, 200); assert.match(dl.type, /spreadsheetml/); assert.match(dl.disp, /events-2026\.xlsx/);
    const evRow = db.prepare("SELECT * FROM events WHERE title='Spring Stableford' AND season_id=?").get(S26);
    const dmy = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
    const addDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + n); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; };
    const was = evRow.event_date; const next = addDays(was, 7);
    const total = db.prepare('SELECT COUNT(*) n FROM events').get().n;
    const before = snapshot(db);
    const buf = await edit(dl.buf, (ws, col) => {
      let r = 2; while (ws.getRow(r).getCell(1).value !== evRow.id) r++;
      ws.getRow(r).getCell(col['Event name']).value = 'Spring Stableford (moved)';
      ws.getRow(r).getCell(col['Date (dd/mm/yyyy)']).value = dmy(next);
      ws.getRow(r).getCell(col['FedEx Cup (Y/N)']).value = 'N';
      ws.spliceRows(2, 1); // a deleted row must not delete the event
      const n = ws.rowCount + 1;
      const row = ws.getRow(n);
      row.getCell(col['Date (dd/mm/yyyy)']).value = '05/12/2026';
      row.getCell(col['Event name']).value = 'Christmas Texas Scramble';
      row.getCell(col.Course).value = 'Brand New Golf Club';
      row.getCell(col.Format).value = 'Texas scramble';
      row.getCell(col['Order of Merit (Y/N)']).value = 'N';
    });
    const up = await upload(cap, buf);
    assert.equal(up.status, 200);
    assert.match(up.text_, /1 new/); assert.match(up.text_, /1 changed/); assert.match(up.text_, /0 with errors/);
    assert.match(up.text_, new RegExp(`Date:.*<del>${dmy(was)}</del> → <ins>${dmy(next)}</ins>`));
    assert.match(up.text_, /Create course “Brand New Golf Club”/);
    assert.equal(snapshot(db), before, 'nothing saved before confirm');
    const r = await cap.post('/admin/events/import/confirm', { token: tokenOf(up.text_), create_courses: 'Brand New Golf Club', action: 'apply' });
    assert.equal(r.status, 302);
    const moved = db.prepare('SELECT * FROM events WHERE id=?').get(evRow.id);
    assert.equal(moved.event_date, next); assert.equal(moved.counts_fedex, 0); assert.match(moved.title, /moved/);
    const xmas = db.prepare("SELECT e.*, c.name cn FROM events e JOIN courses c ON c.id=e.course_id WHERE title='Christmas Texas Scramble'").get();
    assert.equal(xmas.format, 'scramble'); assert.equal(xmas.scoring_basis, 'manual'); assert.equal(xmas.counts_oom, 0); assert.equal(xmas.cn, 'Brand New Golf Club'); assert.equal(xmas.season_id, S26);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, total + 1, 'omitted row kept');
    const audit = db.prepare("SELECT action, detail FROM audit_log WHERE action IN ('events_import','update_event','create_event','create_course') ORDER BY id").all();
    assert.ok(audit.some((a) => a.action === 'events_import' && /1 created, 1 updated/.test(a.detail)));
    assert.ok(audit.some((a) => a.action === 'update_event' && a.detail.includes(`Date ${dmy(was)} → ${dmy(next)}`)));
    assert.ok(audit.some((a) => a.action === 'create_course'));
    // the token is single-use
    assert.equal((await cap.post('/admin/events/import/confirm', { token: tokenOf(up.text_), action: 'apply' })).status, 302);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, total + 1);
  } finally { await app.close(); }
});

test('bad rows are listed and block the import; unticked unknown course is an error', async () => {
  const db = seeded();
  const app = await startApp(db);
  try {
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    const before = snapshot(db);
    const buf = await edit(await XL.exportWorkbook(db, { blank: true }), (ws, col) => {
      const put = (r, vals) => { for (const [k, v] of Object.entries(vals)) ws.getRow(r).getCell(col[k]).value = v; };
      put(2, { 'Date (dd/mm/yyyy)': '31/02/2026', 'Event name': 'Bad date day' });
      put(3, { 'Date (dd/mm/yyyy)': '01/03/2026', 'Event name': 'Mystery course', Course: 'Nowhere Links' });
      put(4, { 'Date (dd/mm/yyyy)': '02/03/2026', 'Event name': 'Odd format', Format: 'Crazy golf' });
      put(5, { ID: 99999, 'Date (dd/mm/yyyy)': '03/03/2026', 'Event name': 'Ghost event' });
      put(6, { 'Date (dd/mm/yyyy)': '04/03/2026', 'Event name': 'Done already', Status: 'completed' });
      put(7, { 'Date (dd/mm/yyyy)': '05/03/2026', 'Event name': 'Yes-ish', 'Order of Merit (Y/N)': 'maybe' });
      put(8, { 'Date (dd/mm/yyyy)': '06/03/2026', 'Event name': 'A good one', Course: 'Kingsbrook' });
    });
    const up = await upload(adm, buf);
    assert.equal(up.status, 200);
    assert.match(up.text_, /2 new/); assert.match(up.text_, /5 with errors/); // unknown course ticked to create by default
    for (const re of [/Bad date &#34;31\/02\/2026&#34;|Bad date "31\/02\/2026"/, /No event with ID 99999/, /Unknown format/, /needs results/, /should be Y or N/]) assert.match(up.text_, re);
    assert.doesNotMatch(up.text_, /Confirm &amp; save/);
    // untick the course: it becomes an error too
    const re = await adm.post('/admin/events/import/confirm', { token: tokenOf(up.text_), action: 'recheck' });
    assert.match(re.text_, /Unknown course &#34;Nowhere Links&#34;|Unknown course "Nowhere Links"/);
    const ap = await adm.post('/admin/events/import/confirm', { token: tokenOf(up.text_), action: 'apply' });
    assert.equal(ap.status, 422);
    assert.equal(snapshot(db), before);
    // not a workbook
    const junk = await upload(adm, Buffer.from('hello'), 'x.xlsx');
    assert.equal(junk.status, 422); assert.match(junk.text_, /not an Excel workbook/);
  } finally { await app.close(); }
});

test('permissions: members cannot export or import; logged-out users are sent to login', async () => {
  const db = seeded();
  const app = await startApp(db);
  try {
    const mem = new Client(app.base); await mem.login('member@example.test', 'flamingo-demo-1');
    assert.equal((await download(mem, '/admin/events/export.xlsx')).status, 403);
    assert.equal((await mem.get('/admin/events/import')).status, 403);
    assert.equal((await upload(mem, await XL.exportWorkbook(db))).status, 403);
    const anon = new Client(app.base);
    assert.equal((await anon.get('/admin/events/export.xlsx')).status, 302);
  } finally { await app.close(); }
});

test('Birdie/FedEx flags: an event switched off drops out of that table', () => {
  const db = seeded();
  const comps = require('../src/lib/comps');
  const S = db.prepare("SELECT id FROM seasons WHERE name='2026'").get().id;
  const t = comps.compTable(db, 'fedex', S);
  const ev = t.events[0].id;
  db.prepare('UPDATE events SET counts_fedex=0 WHERE id=?').run(ev);
  const t2 = comps.compTable(db, 'fedex', S);
  assert.ok(!t2.events.some((e) => e.id === ev));
  assert.ok(comps.compTable(db, 'birdie', S).events.some((e) => e.id === ev));
});

test('Excel buttons are discoverable: public /events (staff only), admin dashboard, admin events', async () => {
  const db = seeded();
  const app = await startApp(db);
  try {
    const cap = new Client(app.base); await cap.login('captain@example.test', 'flamingo-demo-1');
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    const mem = new Client(app.base); await mem.login('member@example.test', 'flamingo-demo-1');
    const ev = (await adm.get('/events')).text_;
    assert.match(ev, /href="\/admin\/events\/export\.xlsx[^"]*"[^>]*>⬇ Export to Excel/);
    assert.match(ev, /href="\/admin\/events\/import"/);
    assert.doesNotMatch((await mem.get('/events')).text_, /Export to Excel|events\/import/);
    assert.match((await adm.get('/admin')).text_, /href="\/admin\/events">Events \(Excel import\/export\)/);
    assert.match((await adm.get('/admin/events')).text_, /Download blank template/);
  } finally { await app.close(); }
});

test('Excel is admin-only: captains and members get 403 and see no buttons; logged-out users are sent to log in', async () => {
  const db = seeded();
  const app = await startApp(db);
  try {
    const ev = db.prepare('SELECT id FROM events ORDER BY id LIMIT 1').get().id;
    const cap = new Client(app.base); await cap.login('captain@example.test', 'flamingo-demo-1');
    const mem = new Client(app.base); await mem.login('member@example.test', 'flamingo-demo-1');
    const anon = new Client(app.base);
    const urls = ['/admin/events/export.xlsx', '/admin/events/export.xlsx?blank=1', '/admin/events/import', `/admin/events/${ev}/scores.xlsx`, `/admin/events/${ev}/scores.xlsx?blank=1`, '/admin/scores.xlsx?season=1', '/admin/scores/import', '/admin/subs.xlsx'];
    const XL = /\.xlsx|events\/import|scores\/import|Excel/;
    for (const u of urls) {
      assert.equal((await cap.get(u)).status, 403, 'captain ' + u);
      assert.equal((await mem.get(u)).status, 403, 'member ' + u);
      const r = await anon.get(u); assert.equal(r.status, 302, 'anon ' + u); assert.match(r.headers.get('location'), /^\/login/);
    }
    for (const [u, p] of [['/admin/events/import/confirm', {}], ['/admin/scores/import/confirm', {}]]) assert.equal((await cap.post(u, p)).status, 403, 'captain POST ' + u);
    for (const p of ['/events', `/events/${ev}`]) for (const c of [cap, mem, anon]) assert.doesNotMatch((await c.get(p)).text_, XL, p);
    for (const p of ['/admin', '/admin/events', `/admin/events/${ev}/results`, `/admin/events/${ev}/edit`, '/admin/subs']) assert.doesNotMatch((await cap.get(p)).text_, XL, 'captain ' + p);
  } finally { await app.close(); }
});
