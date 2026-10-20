'use strict';
/**
 * Excel round-trip for events: export (or a blank template) -> edit in Excel -> import with a preview.
 * - Rows with an ID update that event; rows without one create a new event. Events missing from the sheet are never deleted.
 * - Nothing is written until applyPlan() (the admin confirms the preview).
 */
const ExcelJS = require('exceljs');
const { FORMATS, byKey } = require('./formats');
const { recomputeAll } = require('./engine');

const STATUSES = ['scheduled', 'completed', 'cancelled'];
const YN = ['Y', 'N'];
const MAX_ROWS = 1000;

/** The columns, given the society's switched-on modules. */
function columns({ on = {}, hcpFixed = false } = {}) {
  const c = [
    { key: 'id', header: 'ID', width: 8 },
    { key: 'event_date', header: 'Date (dd/mm/yyyy)', width: 18 },
    { key: 'tee_time', header: 'First tee (hh:mm)', width: 16 },
    { key: 'title', header: 'Event name', width: 42 },
    { key: 'course', header: 'Course', width: 30, list: 'course' },
    { key: 'format', header: 'Format', width: 28, list: 'format' },
    { key: 'season', header: 'Season', width: 10, list: 'season' },
  ];
  if (!hcpFixed) c.push({ key: 'counts_handicap', header: 'Counts for handicap (Y/N)', width: 14, yn: true });
  if (on.oom !== false) c.push({ key: 'counts_oom', header: 'Order of Merit (Y/N)', width: 14, yn: true });
  if (on.birdie !== false) c.push({ key: 'counts_birdie', header: 'Birdie League (Y/N)', width: 14, yn: true });
  if (on.fedex !== false) c.push({ key: 'counts_fedex', header: 'FedEx Cup (Y/N)', width: 14, yn: true });
  if (on.majors !== false) c.push({ key: 'tournament', header: 'Major / Euro (read only)', width: 30, readOnly: true });
  c.push({ key: 'status', header: 'Status', width: 12, list: 'status' }, { key: 'notes', header: 'Notes', width: 60 });
  return c;
}

/** Course labels: the name, plus the tee when two courses share a name. */
function courseLabels(db) {
  const all = db.prepare('SELECT id, name, tee FROM courses ORDER BY name, tee').all();
  const n = new Map(); for (const c of all) n.set(c.name.toLowerCase(), (n.get(c.name.toLowerCase()) || 0) + 1);
  return all.map((c) => ({ id: c.id, label: n.get(c.name.toLowerCase()) > 1 ? `${c.name} (${c.tee})` : c.name }));
}
const formatLabel = (k) => (byKey[k] ? byKey[k].label : k);
const ukDate = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '');

/** The values of one event as they appear in the sheet (also used for diffs). */
function sheetValues(db, e, labels) {
  const course = e.course_id ? labels.find((c) => c.id === e.course_id) : null;
  const season = db.prepare('SELECT name FROM seasons WHERE id=?').get(e.season_id);
  const t = e.tournament_id ? db.prepare('SELECT name FROM tournaments WHERE id=?').get(e.tournament_id) : null;
  return {
    id: e.id, event_date: e.event_date, tee_time: e.tee_time, title: e.title, course: course ? course.label : '', format: formatLabel(e.format),
    season: season ? season.name : '', counts_handicap: e.counts_handicap ? 'Y' : 'N', counts_oom: e.counts_oom ? 'Y' : 'N',
    counts_birdie: e.counts_birdie ? 'Y' : 'N', counts_fedex: e.counts_fedex ? 'Y' : 'N', tournament: t ? `${t.name}${e.round_no ? ` (round ${e.round_no})` : ''}` : '',
    status: e.status, notes: e.notes || '',
  };
}

async function exportWorkbook(db, { seasonId = null, blank = false, on = {}, hcpFixed = false, societyName = 'Society' } = {}) {
  const cols = columns({ on, hcpFixed });
  const labels = courseLabels(db);
  const seasons = db.prepare('SELECT name FROM seasons ORDER BY year DESC, start_date DESC').all().map((s) => s.name);
  const events = blank ? [] : db.prepare(`SELECT * FROM events WHERE (? IS NULL OR season_id=?) ORDER BY event_date, id`).all(seasonId, seasonId);
  const wb = new ExcelJS.Workbook();
  wb.creator = societyName; wb.created = new Date();
  const ws = wb.addWorksheet('Events', { views: [{ state: 'frozen', ySplit: 1, xSplit: 2 }] });
  const ins = wb.addWorksheet('Instructions');
  const lists = wb.addWorksheet('Lists', { state: 'hidden' });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF064E3B' } };
  head.alignment = { vertical: 'middle', wrapText: true }; head.height = 32;
  ws.getColumn('id').hidden = true;
  for (const e of events) {
    const v = sheetValues(db, e, labels);
    const row = {}; for (const c of cols) row[c.key] = v[c.key];
    row.event_date = v.event_date ? new Date(`${v.event_date}T00:00:00Z`) : null;
    ws.addRow(row);
  }
  ws.getColumn('event_date').numFmt = 'dd/mm/yyyy';
  ws.getColumn('tee_time').numFmt = '@';
  // lists for the dropdowns
  const L = { course: labels.map((c) => c.label), format: FORMATS.map((f) => f.label), season: seasons, status: STATUSES, yn: YN };
  const lcols = Object.keys(L);
  lcols.forEach((k, i) => { lists.getCell(1, i + 1).value = k; L[k].forEach((v, j) => { lists.getCell(j + 2, i + 1).value = v; }); });
  const ref = (k) => { const i = lcols.indexOf(k); const col = String.fromCharCode(65 + i); return `Lists!$${col}$2:$${col}$${Math.max(2, L[k].length + 1)}`; };
  const last = Math.max(events.length + 1, 2) + 300; // room for new rows
  cols.forEach((c, i) => {
    const colL = ws.getColumn(i + 1).letter;
    for (let r = 2; r <= last; r++) {
      const cell = ws.getCell(`${colL}${r}`);
      if (c.key !== 'id' && !c.readOnly) cell.protection = { locked: false };
      if (c.list || c.yn) cell.dataValidation = { type: 'list', allowBlank: true, formulae: [ref(c.yn ? 'yn' : c.list)], showErrorMessage: c.key !== 'course', errorStyle: c.key === 'course' ? 'warning' : 'stop', errorTitle: c.header, error: c.key === 'course' ? 'Not a known course: the import will offer to create it.' : 'Pick a value from the list.' };
      if (c.key === 'event_date') cell.dataValidation = { type: 'date', operator: 'between', allowBlank: true, formulae: [new Date('2000-01-01'), new Date('2100-12-31')], showErrorMessage: true, error: 'Enter a date as dd/mm/yyyy.' };
      if (c.readOnly) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
    }
  });
  await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true, sort: true, autoFilter: true });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };

  ins.getColumn(1).width = 110;
  const lines = [
    [`${societyName}: events workbook`, true],
    [blank ? 'Blank template: one row per new event.' : `Exported ${new Date().toISOString().slice(0, 10)}${seasonId ? ` (season ${db.prepare('SELECT name FROM seasons WHERE id=?').get(seasonId).name})` : ' (all seasons)'}: ${events.length} events.`],
    [''],
    ['How it works', true],
    ['• Edit rows on the Events sheet, or add new rows at the bottom. Then Admin → Events → Import from Excel.'],
    ['• You get a preview first (new / changed / unchanged / errors). Nothing is saved until you confirm.'],
    ['• Each existing event carries a hidden ID column. Keep it: a row with an ID updates that event; a row without one creates a new event.'],
    ['• Deleting a row does NOT delete the event. Delete or cancel events in the app (or set Status to cancelled).'],
    [''],
    ['Columns', true],
    ['• Date: dd/mm/yyyy (UK). First tee: hh:mm, 24-hour (blank = 09:00 for new events).'],
    ['• Course: pick from the list. A course the app doesn’t know is flagged in the preview, where you can choose to create it.'],
    ['• Format and Season: pick from the list. Y/N columns: Y counts the event for that competition, N doesn’t.'],
    ['• Status: scheduled, completed or cancelled. An event can only be completed once it has results (enter them in the app).'],
    ['• Major / Euro is shown for information; change tournament rounds in Admin → Tournaments.'],
    ['• Results are not part of this workbook: enter them in the app.'],
  ];
  lines.forEach(([t, b], i) => { const c = ins.getCell(i + 1, 1); c.value = t; if (b) c.font = { bold: true, size: i ? 12 : 14 }; c.alignment = { wrapText: true }; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- import
const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText(v.result);
    if (v.text != null) return String(v.text);
    if (v.hyperlink) return String(v.text || v.hyperlink);
  }
  return typeof v === 'number' ? v : String(v).trim();
};
const pad = (n) => String(n).padStart(2, '0');
function parseDate(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + v * 864e5); return parseDate(d); }
  const s = String(v || '').trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  let y; let mo; let d;
  if (m) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; } else if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) { y = +m[1]; mo = +m[2]; d = +m[3]; } else return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d || y < 2000 || y > 2100) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}
function parseTime(v) {
  if (v instanceof Date && !isNaN(v)) return `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
  if (typeof v === 'number' && v >= 0 && v < 1) { const mins = Math.round(v * 1440); return `${pad(Math.floor(mins / 60))}:${pad(mins % 60)}`; }
  const m = String(v || '').trim().match(/^(\d{1,2})[:.](\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) return null;
  return `${pad(+m[1])}:${m[2]}`;
}

/** Read the Events sheet into raw rows keyed by column (matched on the header text, so column order doesn't matter). */
async function readWorkbook(buf, { on = {}, hcpFixed = false } = {}) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch (e) { const err = new Error('That file is not an Excel workbook (.xlsx).'); err.code = 'BAD_FILE'; throw err; }
  const ws = wb.getWorksheet('Events') || wb.worksheets[0];
  if (!ws) { const err = new Error('The workbook has no Events sheet.'); err.code = 'BAD_FILE'; throw err; }
  const cols = columns({ on, hcpFixed });
  const norm = (s) => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z]/g, '');
  const byHead = new Map(cols.map((c) => [norm(c.header), c.key]));
  const at = {};
  ws.getRow(1).eachCell((cell, i) => { const k = byHead.get(norm(cellText(cell.value))); if (k) at[k] = i; });
  for (const need of ['event_date', 'title']) if (!at[need]) { const err = new Error(`The Events sheet is missing the "${cols.find((c) => c.key === need).header}" column. Start from an export or the blank template.`); err.code = 'BAD_FILE'; throw err; }
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const raw = {};
    for (const [k, i] of Object.entries(at)) {
      let v = cellText(row.getCell(i).value);
      // plain JSON-safe values (the preview is kept in the session until confirmed)
      if (v instanceof Date) v = k === 'tee_time' ? parseTime(v) || '' : parseDate(v) || '';
      else if (typeof v === 'number' && k === 'event_date') v = parseDate(v) || String(v);
      else if (typeof v === 'number' && k === 'tee_time') v = parseTime(v) || String(v);
      raw[k] = v;
    }
    if (Object.entries(raw).every(([k, v]) => k === 'tournament' || v === '' || v == null)) continue;
    rows.push({ rowNo: r, raw });
    if (rows.length > MAX_ROWS) { const err = new Error(`Too many rows (max ${MAX_ROWS}).`); err.code = 'BAD_FILE'; throw err; }
  }
  return { rows, present: Object.keys(at) };
}

const FIELD_LABEL = { event_date: 'Date', tee_time: 'First tee', title: 'Name', course: 'Course', format: 'Format', season: 'Season', counts_handicap: 'Handicap', counts_oom: 'Order of Merit', counts_birdie: 'Birdie League', counts_fedex: 'FedEx Cup', status: 'Status', notes: 'Notes' };

/**
 * Validate rows against the database and work out what would happen. Returns
 * { rows: [{ rowNo, kind: new|changed|unchanged|error, id, title, diffs: [{field,label,from,to}], errors: [], values }], unknownCourses: [names], counts }
 * opts.createCourses: names (case-insensitive) the admin agreed to create; other unknown courses are errors.
 */
function plan(db, { rows, present }, { createCourses = [] } = {}) {
  const labels = courseLabels(db);
  const courseBy = new Map(); for (const c of labels) courseBy.set(c.label.toLowerCase(), c.id);
  for (const c of db.prepare('SELECT id, name FROM courses').all()) if (!courseBy.has(c.name.toLowerCase())) courseBy.set(c.name.toLowerCase(), c.id);
  const fmtBy = new Map(); for (const f of FORMATS) { fmtBy.set(f.label.toLowerCase(), f.key); fmtBy.set(f.key, f.key); }
  const seasonBy = new Map(db.prepare('SELECT id, name FROM seasons').all().map((s) => [s.name.toLowerCase(), s.id]));
  const create = new Set(createCourses.map((s) => String(s).trim().toLowerCase()));
  const unknown = new Map();
  const seenIds = new Set();
  const out = [];
  const has = (k) => present.includes(k);
  for (const { rowNo, raw } of rows) {
    const errors = [];
    let id = null;
    if (has('id') && raw.id !== '' && raw.id != null) {
      id = Number(raw.id);
      if (!Number.isInteger(id) || id < 1) { errors.push(`ID "${raw.id}" is not valid (leave it blank for a new event)`); id = null; }
      else if (seenIds.has(id)) errors.push(`ID ${id} appears twice in the sheet`);
      else seenIds.add(id);
    }
    const cur = id ? db.prepare('SELECT * FROM events WHERE id=?').get(id) : null;
    if (id && !cur) errors.push(`No event with ID ${id} (it may have been deleted). Clear the ID to create it as a new event.`);
    const v = {};
    // date
    const d = parseDate(raw.event_date);
    if (!d) errors.push(raw.event_date === '' || raw.event_date == null ? 'Date is missing' : `Bad date "${raw.event_date instanceof Date ? raw.event_date.toISOString().slice(0, 10) : raw.event_date}" (use dd/mm/yyyy)`); else v.event_date = d;
    // tee time
    if (has('tee_time') && raw.tee_time !== '') { const t = parseTime(raw.tee_time); if (!t) errors.push(`Bad first tee "${raw.tee_time}" (use hh:mm)`); else v.tee_time = t; } else v.tee_time = cur ? cur.tee_time : '09:00';
    // title
    const title = String(raw.title || '').trim();
    if (title.length < 3 || title.length > 100) errors.push(title ? 'Name must be 3–100 characters' : 'Name is missing'); else v.title = title;
    // course
    if (has('course')) {
      const cn = String(raw.course || '').trim();
      if (!cn) v.course_id = null;
      else if (courseBy.has(cn.toLowerCase())) v.course_id = courseBy.get(cn.toLowerCase());
      else { unknown.set(cn.toLowerCase(), cn); if (create.has(cn.toLowerCase())) { v.course_id = null; v.newCourse = cn; } else errors.push(`Unknown course "${cn}"`); }
    } else v.course_id = cur ? cur.course_id : null;
    // format
    if (has('format') && String(raw.format || '').trim()) { const k = fmtBy.get(String(raw.format).trim().toLowerCase()); if (!k) errors.push(`Unknown format "${raw.format}"`); else v.format = k; } else v.format = cur ? cur.format : 'stableford';
    // season
    if (has('season') && String(raw.season || '').trim() !== '') {
      const s = seasonBy.get(String(raw.season).trim().toLowerCase());
      if (!s) errors.push(`Unknown season "${raw.season}"`); else v.season_id = s;
    } else if (cur) v.season_id = cur.season_id;
    else if (v.event_date) { const s = db.prepare('SELECT id FROM seasons WHERE start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1').get(v.event_date, v.event_date); if (s) v.season_id = s.id; else errors.push('Season is missing (no season covers that date)'); }
    // Y/N
    for (const k of ['counts_handicap', 'counts_oom', 'counts_birdie', 'counts_fedex']) {
      if (has(k) && String(raw[k] || '').trim() !== '') {
        const s = String(raw[k]).trim().toUpperCase();
        if (['Y', 'YES', 'TRUE', '1'].includes(s)) v[k] = 1; else if (['N', 'NO', 'FALSE', '0'].includes(s)) v[k] = 0; else errors.push(`${FIELD_LABEL[k]}: "${raw[k]}" should be Y or N`);
      } else v[k] = cur ? cur[k] : 1;
    }
    // status
    if (has('status') && String(raw.status || '').trim()) {
      const s = String(raw.status).trim().toLowerCase();
      if (!STATUSES.includes(s)) errors.push(`Unknown status "${raw.status}"`); else v.status = s;
    } else v.status = cur ? cur.status : 'scheduled';
    if (v.status === 'completed' && !(cur && db.prepare('SELECT 1 FROM results WHERE event_id=?').get(cur.id))) errors.push('Status "completed" needs results: enter them in the app (use scheduled)');
    // notes
    if (has('notes')) { const n = String(raw.notes || '').trim(); if (n.length > 600) errors.push('Notes are longer than 600 characters'); else v.notes = n || null; } else v.notes = cur ? cur.notes : null;

    const row = { rowNo, id, title: v.title || title || '(no name)', values: v, errors, diffs: [] };
    if (errors.length) { row.kind = 'error'; out.push(row); continue; }
    if (!cur) { row.kind = 'new'; out.push(row); continue; }
    const before = sheetValues(db, cur, labels);
    const afterEv = { ...cur, ...v };
    const after = sheetValues(db, afterEv, labels);
    if (v.newCourse) after.course = v.newCourse;
    for (const k of Object.keys(FIELD_LABEL)) {
      if (k === 'counts_handicap' && !has(k)) continue;
      const changed = k === 'course' ? (cur.course_id !== v.course_id || !!v.newCourse) : String(before[k] ?? '') !== String(after[k] ?? '');
      if (changed) row.diffs.push({ field: k, label: FIELD_LABEL[k], from: k === 'event_date' ? ukDate(before[k]) : before[k], to: k === 'event_date' ? ukDate(after[k]) : after[k] });
    }
    row.kind = row.diffs.length ? 'changed' : 'unchanged';
    out.push(row);
  }
  const counts = { new: 0, changed: 0, unchanged: 0, error: 0 };
  for (const r of out) counts[r.kind]++;
  return { rows: out, unknownCourses: [...unknown.values()], counts };
}

/** Apply a plan with no errors, in one transaction. Returns { created: [ids], updated: [ids], coursesCreated: [names] }. */
function applyPlan(db, p, { audit = () => {} } = {}) {
  if (p.counts.error) throw Object.assign(new Error('Fix the errors first'), { code: 'INVALID' });
  const res = { created: [], updated: [], coursesCreated: [] };
  db.transaction(() => {
    const made = new Map();
    const course = (name) => {
      const k = name.toLowerCase();
      if (!made.has(k)) { made.set(k, db.prepare("INSERT INTO courses(name,tee,par,rating,slope,location) VALUES (?,'Yellow',72,72,113,NULL)").run(name).lastInsertRowid); res.coursesCreated.push(name); audit('create_course', `course ${made.get(k)} "${name}" (from the events import; par/rating/slope are placeholders)`); }
      return made.get(k);
    };
    for (const r of p.rows) {
      if (r.kind !== 'new' && r.kind !== 'changed') continue;
      const v = { ...r.values };
      if (v.newCourse) v.course_id = course(v.newCourse);
      if (r.kind === 'new') {
        const f = byKey[v.format] || byKey.stableford;
        const id = db.prepare(`INSERT INTO events(season_id,title,course_id,event_date,tee_time,format,scoring_basis,notes,status,counts_handicap,counts_oom,counts_birdie,counts_fedex)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.season_id, v.title, v.course_id, v.event_date, v.tee_time, v.format, f.basis, v.notes, v.status, v.counts_handicap, v.counts_oom, v.counts_birdie, v.counts_fedex).lastInsertRowid;
        res.created.push(id);
        audit('create_event', `event ${id} "${v.title}" (Excel import, row ${r.rowNo})`);
      } else {
        const cur = db.prepare('SELECT format, scoring_basis FROM events WHERE id=?').get(r.id);
        const basis = cur.format !== v.format ? (byKey[v.format] || byKey.stableford).basis : cur.scoring_basis;
        db.prepare(`UPDATE events SET season_id=?,title=?,course_id=?,event_date=?,tee_time=?,format=?,scoring_basis=?,notes=?,status=?,counts_handicap=?,counts_oom=?,counts_birdie=?,counts_fedex=? WHERE id=?`)
          .run(v.season_id, v.title, v.course_id, v.event_date, v.tee_time, v.format, basis, v.notes, v.status, v.counts_handicap, v.counts_oom, v.counts_birdie, v.counts_fedex, r.id);
        res.updated.push(r.id);
        audit('update_event', `event ${r.id} "${v.title}" (Excel import, row ${r.rowNo}): ${r.diffs.map((d) => `${d.label} ${d.from === '' ? '—' : d.from} → ${d.to === '' ? '—' : d.to}`).join('; ')}`);
      }
    }
    recomputeAll(db);
  })();
  return res;
}

module.exports = { columns, exportWorkbook, readWorkbook, plan, applyPlan, parseDate, parseTime, courseLabels, STATUSES };
