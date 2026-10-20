'use strict';
/**
 * Excel round-trip for an event's players and scores (one row per player per event), for one event or a season.
 * Import: adds players to the field, creates/updates results and Birdie/FedEx entries, then recalculates.
 * It never removes a player or a score by omission: a blank cell means "leave as it is" (remove via Manage players).
 */
const ExcelJS = require('exceljs');
const { recomputeAll } = require('./engine');
const Field = require('./field');
const { parseDate } = require('./events-xlsx');

const MAX_ROWS = 5000;
const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function columns({ on = {} } = {}) {
  const c = [
    { key: 'event_id', header: 'Event ID', width: 9, locked: true },
    { key: 'event_date', header: 'Date', width: 12, locked: true },
    { key: 'event', header: 'Event', width: 40, locked: true },
    { key: 'player', header: 'Player', width: 26, list: true },
    { key: 'hcp', header: 'Handicap played off', width: 12 },
    { key: 'gross', header: 'Gross', width: 9 },
    { key: 'stableford', header: 'Stableford points', width: 12 },
  ];
  if (on.birdie !== false) c.push({ key: 'birdie', header: 'Birdies', width: 9 });
  if (on.fedex !== false) c.push({ key: 'fedex', header: 'FedEx points', width: 10 });
  c.push({ key: 'note', header: 'Notes', width: 40 });
  return c;
}

/** The current sheet values for one player in one event. */
function current(db, ev, u) {
  const r = db.prepare('SELECT * FROM results WHERE event_id=? AND user_id=?').get(ev.id, u.id);
  const cs = {}; for (const x of db.prepare('SELECT comp, value FROM comp_scores WHERE event_id=? AND user_id=?').all(ev.id, u.id)) cs[x.comp] = x.value;
  const eff = r ? (r.hcp_played ?? r.idx_at_event) : u.handicap_index;
  return { r, hcp: r1(eff), hcp_played: r ? r.hcp_played : null, gross: r ? r.gross : null, stableford: r ? (r.stableford_in ?? r.stableford) : null,
    birdie: cs.birdie ?? null, fedex: cs.fedex ?? null, note: r ? r.note || '' : '' };
}

function eventsFor(db, { eventId = null, seasonId = null }) {
  if (eventId) return db.prepare('SELECT * FROM events WHERE id=?').all(eventId);
  return db.prepare("SELECT * FROM events WHERE season_id=? AND status!='cancelled' ORDER BY event_date, id").all(seasonId);
}

async function exportWorkbook(db, { eventId = null, seasonId = null, blank = false, on = {}, societyName = 'Society' } = {}) {
  const cols = columns({ on });
  const events = eventsFor(db, { eventId, seasonId });
  const wb = new ExcelJS.Workbook(); wb.creator = societyName; wb.created = new Date();
  const ws = wb.addWorksheet('Scores', { views: [{ state: 'frozen', ySplit: 1, xSplit: 4 }] });
  const ins = wb.addWorksheet('Instructions');
  const lists = wb.addWorksheet('Lists', { state: 'hidden' });
  ws.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1); head.font = { bold: true, color: { argb: 'FFFFFFFF' } }; head.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF064E3B' } }; head.height = 30; head.alignment = { wrapText: true, vertical: 'middle' };
  const members = db.prepare("SELECT name FROM users ORDER BY status='active' DESC, name").all().map((m) => m.name);
  members.forEach((n, i) => { lists.getCell(i + 1, 1).value = n; });
  const evRow = (e) => ({ event_id: e.id, event_date: new Date(`${e.event_date}T00:00:00Z`), event: e.title });
  let n = 0;
  for (const e of events) {
    const field = blank ? [] : Field.list(db, e.id);
    for (const u of field) {
      const c = current(db, e, u);
      ws.addRow({ ...evRow(e), player: u.name, hcp: c.hcp, gross: c.gross, stableford: c.stableford, birdie: c.birdie, fedex: c.fedex, note: c.note }); n++;
    }
    const spare = blank ? (eventId ? 40 : 30) : (eventId ? 10 : 0); // empty rows to add players to (event columns filled in)
    for (let i = 0; i < spare; i++) ws.addRow(evRow(e));
  }
  ws.getColumn('event_date').numFmt = 'dd/mm/yyyy';
  ws.getColumn('event_id').hidden = false;
  const last = ws.rowCount + 200;
  cols.forEach((c, i) => {
    for (let r = 2; r <= last; r++) {
      const cell = ws.getCell(r, i + 1);
      if (!c.locked || r > ws.rowCount) cell.protection = { locked: false };
      if (c.locked && r <= ws.rowCount) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5F9' } };
      if (c.list) cell.dataValidation = { type: 'list', allowBlank: true, formulae: [`Lists!$A$1:$A$${Math.max(1, members.length)}`], showErrorMessage: true, errorStyle: 'warning', error: 'Not a member name: the import will suggest matches.' };
      else if (['gross', 'stableford', 'birdie'].includes(c.key)) cell.dataValidation = { type: 'whole', operator: 'between', allowBlank: true, formulae: [0, 200], showErrorMessage: true, error: 'Whole number' };
      else if (['hcp', 'fedex'].includes(c.key)) cell.dataValidation = { type: 'decimal', operator: 'between', allowBlank: true, formulae: [-10, 100], showErrorMessage: true, error: 'Number' };
    }
  });
  await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, sort: true, autoFilter: true, insertRows: true });
  ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
  ins.getColumn(1).width = 110;
  const what = eventId ? `event "${events[0] ? events[0].title : ''}"` : `season ${db.prepare('SELECT name FROM seasons WHERE id=?').get(seasonId)?.name || ''}`;
  const lines = [[`${societyName}: players & scores`, true], [`${blank ? 'Blank template' : 'Export'} for ${what}${blank ? '' : `: ${n} player rows`}.`], [''], ['How it works', true],
    ['• One row per player per event. The grey Event ID / Date / Event cells identify the event: keep them (copy a row to add another player to that event).'],
    ['• Player: pick a member (name or nickname). Unknown names are flagged in the preview with suggestions.'],
    ['• Handicap played off: leave as exported to use the player’s handicap; type another figure to record what they actually played off.'],
    ['• Enter Gross and/or Stableford points. Birdies and FedEx points are optional.'],
    ['• Blank cells leave what’s in the app unchanged. Deleting a row does NOT remove the player or their score: use Manage players.'],
    ['• Upload with Import scores from Excel. You get a preview (new / changed / unchanged / errors); nothing is saved until you confirm.'],
    ['• Importing adds new players to the event’s field, saves scores, and recalculates standings and leaderboards.']];
  lines.forEach(([t, b], i) => { const c = ins.getCell(i + 1, 1); c.value = t; c.alignment = { wrapText: true }; if (b) c.font = { bold: true, size: i ? 12 : 14 }; });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v;
  if (typeof v === 'object') { if (v.richText) return v.richText.map((t) => t.text).join(''); if ('result' in v) return cellText(v.result); if (v.text != null) return String(v.text); }
  return typeof v === 'number' ? v : String(v).trim();
};

async function readWorkbook(buf, { on = {} } = {}) {
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf); } catch (e) { throw Object.assign(new Error('That file is not an Excel workbook (.xlsx).'), { code: 'BAD_FILE' }); }
  const ws = wb.getWorksheet('Scores') || wb.worksheets[0];
  const cols = columns({ on });
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const byHead = new Map(cols.map((c) => [norm(c.header), c.key]));
  const at = {};
  ws.getRow(1).eachCell((cell, i) => { const k = byHead.get(norm(cellText(cell.value))); if (k) at[k] = i; });
  for (const need of ['event_id', 'player']) if (!at[need]) throw Object.assign(new Error(`The Scores sheet is missing the "${cols.find((c) => c.key === need).header}" column. Start from an export or a blank template.`), { code: 'BAD_FILE' });
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const raw = {};
    for (const [k, i] of Object.entries(at)) { let v = cellText(ws.getRow(r).getCell(i).value); if (v instanceof Date) v = parseDate(v) || ''; raw[k] = v; }
    const data = ['player', 'hcp', 'gross', 'stableford', 'birdie', 'fedex', 'note'].filter((k) => raw[k] !== '' && raw[k] != null);
    if (!data.length) continue; // event cells only (a spare row)
    rows.push({ rowNo: r, raw });
    if (rows.length > MAX_ROWS) throw Object.assign(new Error(`Too many rows (max ${MAX_ROWS}).`), { code: 'BAD_FILE' });
  }
  return { rows, present: Object.keys(at) };
}

function lev(a, b) {
  const m = a.length; const n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[m][n];
}
function suggest(members, name) {
  const q = name.toLowerCase();
  return members.map((m) => {
    const keys = [m.name, m.nickname].filter(Boolean).map((s) => s.toLowerCase());
    const score = Math.min(...keys.map((k) => (k.includes(q) || q.includes(k) ? 0 : 1) * 2 + lev(q, k) / Math.max(q.length, k.length)));
    const surname = keys.some((k) => k.split(' ').some((w) => w.length > 2 && q.split(' ').includes(w)));
    return { m, score: surname ? Math.min(score, 0.5) : score };
  }).filter((x) => x.score < 1.5).sort((a, b) => a.score - b.score).slice(0, 3).map((x) => x.m.name);
}

const LABEL = { player: 'Player', hcp: 'Handicap played off', gross: 'Gross', stableford: 'Stableford', birdie: 'Birdies', fedex: 'FedEx points', note: 'Notes' };

/** Validate + diff. Rows: kind new (player added to the field) | changed | unchanged | error. */
function plan(db, { rows, present }, { allowedEventIds = null } = {}) {
  const members = db.prepare('SELECT id, name, nickname, status, handicap_index FROM users').all();
  const byName = new Map();
  for (const m of members) for (const k of [m.name, m.nickname].filter(Boolean)) { const key = k.toLowerCase(); byName.set(key, byName.has(key) && byName.get(key).id !== m.id ? 'AMBIG' : m); }
  const seen = new Set();
  const out = [];
  const num = (v, { int = false, min, max, label }, errors) => {
    if (v === '' || v == null) return undefined;
    const x = typeof v === 'number' ? v : Number(String(v).replace(',', '.'));
    if (!Number.isFinite(x) || (int && !Number.isInteger(x)) || x < min || x > max) { errors.push(`${label} "${v}" should be ${int ? 'a whole number' : 'a number'} ${min}–${max}`); return undefined; }
    return x;
  };
  for (const { rowNo, raw } of rows) {
    const errors = [];
    const eid = Number(raw.event_id);
    const ev = Number.isInteger(eid) && eid > 0 ? db.prepare('SELECT * FROM events WHERE id=?').get(eid) : null;
    if (!ev) errors.push(raw.event_id === '' ? 'Event ID is missing (copy the grey event cells from another row)' : `No event with ID ${raw.event_id}`);
    else if (allowedEventIds && !allowedEventIds.includes(ev.id)) errors.push(`Event ${ev.id} is not part of this import`);
    else if (ev.status === 'cancelled') errors.push(`"${ev.title}" is cancelled`);
    const pname = String(raw.player || '').trim();
    let u = null;
    if (!pname) errors.push('Player is missing');
    else {
      const hit = byName.get(pname.toLowerCase());
      if (hit === 'AMBIG') errors.push(`"${pname}" matches more than one member: use the full name`);
      else if (hit) u = hit;
      else { const s = suggest(members, pname); errors.push(`Unknown player "${pname}"${s.length ? ` — did you mean ${s.join(', ')}?` : ''}`); }
    }
    if (ev && u) { const k = `${ev.id}:${u.id}`; if (seen.has(k)) errors.push(`${u.name} appears twice for this event`); seen.add(k); }
    const v = {
      hcp: num(raw.hcp, { min: -10, max: 54, label: 'Handicap' }, errors),
      gross: num(raw.gross, { int: true, min: 18, max: 200, label: 'Gross' }, errors),
      stableford: num(raw.stableford, { int: true, min: 0, max: 80, label: 'Stableford' }, errors),
      birdie: present.includes('birdie') ? num(raw.birdie, { int: true, min: 0, max: 18, label: 'Birdies' }, errors) : undefined,
      fedex: present.includes('fedex') ? num(raw.fedex, { min: 0, max: 100, label: 'FedEx points' }, errors) : undefined,
      note: raw.note === '' || raw.note == null ? undefined : String(raw.note).trim().slice(0, 120),
    };
    const row = { rowNo, eventId: ev && ev.id, event: ev ? ev.title : String(raw.event || ''), date: ev && ev.event_date, player: u ? u.name : pname, userId: u && u.id, values: v, errors, diffs: [] };
    if (errors.length) { row.kind = 'error'; out.push(row); continue; }
    const c = current(db, ev, u);
    const inField = Field.inField(db, ev.id, u.id);
    if (!c.r && v.gross === undefined && v.stableford === undefined && v.hcp !== undefined && v.hcp !== c.hcp) {
      errors.push('A handicap without a score can’t be saved: enter Gross or Stableford (or leave the handicap as exported)');
    }
    if (errors.length) { row.kind = 'error'; out.push(row); continue; }
    const d = (k, from, to) => { if (to !== undefined && String(from ?? '') !== String(to ?? '')) row.diffs.push({ field: k, label: LABEL[k], from: from ?? '', to }); };
    d('hcp', c.hcp, v.hcp);
    d('gross', c.gross, v.gross);
    d('stableford', c.stableford, v.stableford);
    d('birdie', c.birdie, v.birdie);
    d('fedex', c.fedex, v.fedex);
    d('note', c.note, v.note);
    row.addToField = !inField;
    row.kind = row.addToField ? 'new' : row.diffs.length ? 'changed' : 'unchanged';
    out.push(row);
  }
  const counts = { new: 0, changed: 0, unchanged: 0, error: 0 };
  for (const r of out) counts[r.kind]++;
  return { rows: out, counts };
}

function applyPlan(db, p, { actorId = null, audit = () => {} } = {}) {
  if (p.counts.error) throw Object.assign(new Error('Fix the errors first'), { code: 'INVALID' });
  const out = { added: 0, results: 0, comps: 0, events: new Set() };
  db.transaction(() => {
    const fIns = db.prepare('INSERT OR IGNORE INTO event_players(event_id,user_id,added_by) VALUES (?,?,?)');
    for (const r of p.rows) {
      if (r.kind !== 'new' && r.kind !== 'changed') continue;
      const v = r.values; const ev = r.eventId; const u = r.userId;
      if (r.addToField) { fIns.run(ev, u, actorId); out.added++; }
      const ch = new Set(r.diffs.map((x) => x.field));
      const cur = db.prepare('SELECT * FROM results WHERE event_id=? AND user_id=?').get(ev, u);
      if (ch.has('gross') || ch.has('stableford') || ch.has('hcp') || (ch.has('note') && cur) || (!cur && (v.gross !== undefined || v.stableford !== undefined))) {
        const hcp = ch.has('hcp') ? v.hcp : cur ? cur.hcp_played : null;
        const gross = ch.has('gross') ? v.gross : cur ? cur.gross : null;
        let stb = cur ? cur.stableford_in : null;
        if (ch.has('stableford')) stb = v.stableford;
        if (ch.has('gross') && !ch.has('stableford') && cur && cur.stableford_in != null && cur.gross != null) stb = null; // gross changed: re-derive points
        const note = ch.has('note') ? v.note || null : cur ? cur.note : null;
        if (cur) db.prepare('UPDATE results SET gross=?, stableford_in=?, hcp_played=?, note=? WHERE id=?').run(gross, stb, hcp, note, cur.id);
        else db.prepare('INSERT INTO results(event_id,user_id,gross,stableford_in,hcp_played,note,bonus) VALUES (?,?,?,?,?,?,0)').run(ev, u, gross, stb, hcp, note);
        out.results++;
      } else if (ch.has('note') && !cur) { /* a note with no score has nowhere to go */ }
      for (const comp of ['birdie', 'fedex']) {
        if (!ch.has(comp)) continue;
        db.prepare('INSERT INTO comp_scores(comp,event_id,user_id,value) VALUES (?,?,?,?) ON CONFLICT(comp,event_id,user_id) DO UPDATE SET value=excluded.value').run(comp, ev, u, v[comp]);
        out.comps++;
      }
      out.events.add(ev);
      audit('import_score', `event ${ev} "${r.event}": ${r.player} (user ${u})${r.addToField ? ' added to the field' : ''}${r.diffs.length ? ': ' + r.diffs.map((x) => `${x.label} ${x.from === '' ? '—' : x.from} → ${x.to}`).join('; ') : ''} (Excel row ${r.rowNo})`);
    }
    for (const ev of out.events) if (db.prepare('SELECT 1 FROM results WHERE event_id=?').get(ev)) db.prepare("UPDATE events SET status='completed' WHERE id=? AND status='scheduled'").run(ev);
    recomputeAll(db);
  })();
  return { ...out, events: [...out.events] };
}

module.exports = { columns, exportWorkbook, readWorkbook, plan, applyPlan, suggest };
