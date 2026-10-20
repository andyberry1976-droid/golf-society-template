'use strict';
/**
 * Read a society's spreadsheet(s) into the normalised import shape (see seed/import.js).
 * XLSX: one sheet per kind, named Members, Courses, Events, Results, Honours (case-insensitive, extra sheets ignored).
 * CSV:  one file per kind, named members.csv, courses.csv … (or pass kind=path).
 * First row = headers. Header names are matched loosely (e.g. "Handicap", "HCP", "Index" all mean handicap).
 */
const fs = require('fs');
const path = require('path');

const KINDS = ['members', 'courses', 'events', 'results', 'honours'];
const HEADERS = {
  name: ['name', 'member', 'player name', 'full name'], email: ['email', 'e-mail', 'email address'],
  handicap: ['handicap', 'hcp', 'index', 'handicap index', 'h/cap'], nickname: ['nickname', 'nick'], role: ['role'], joined_on: ['joined', 'joined on', 'join date'],
  tee: ['tee'], par: ['par'], rating: ['rating', 'course rating', 'cr'], slope: ['slope', 'slope rating'], location: ['location', 'town'],
  key: ['key', 'id', 'code'], title: ['title', 'event', 'event name'], date: ['date', 'event date'], course: ['course', 'venue'], tee_time: ['tee time', 'time'],
  status: ['status'], counts_handicap: ['counts handicap', 'handicap counts'], counts_oom: ['counts oom', 'oom'],
  event: ['event', 'event key', 'event title', 'event date'], player: ['player', 'name', 'member'], stableford: ['stableford', 'points', 'pts'], gross: ['gross', 'score'], position: ['position', 'pos', 'place'],
  category: ['category', 'trophy', 'honour'], year: ['year', 'season'], detail: ['detail', 'note', 'notes'],
};
const FIELDS = {
  members: ['name', 'email', 'handicap', 'nickname', 'role', 'joined_on'], courses: ['name', 'tee', 'par', 'rating', 'slope', 'location'],
  events: ['key', 'title', 'date', 'course', 'tee_time', 'status', 'counts_handicap', 'counts_oom'], results: ['event', 'player', 'stableford', 'gross', 'position'],
  honours: ['category', 'year', 'player', 'detail'],
};
const NUM = new Set(['handicap', 'par', 'rating', 'slope', 'stableford', 'gross', 'position', 'year']);
const BOOL = new Set(['counts_handicap', 'counts_oom']);

function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  text = String(text).replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; continue; }
    if (c === '"') q = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}

const isoDate = (v) => {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/); // UK day/month/year
  if (m) return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return s;
};

/** rows (array of arrays, first = headers) -> objects with normalised field names. */
function normalise(kind, rows) {
  if (!rows.length) return [];
  const head = rows[0].map((h) => String(h == null ? '' : h).trim().toLowerCase());
  const col = {};
  for (const f of FIELDS[kind]) { const i = head.findIndex((h) => h === f || HEADERS[f].includes(h)); if (i >= 0) col[f] = i; }
  const out = [];
  for (const r of rows.slice(1)) {
    const o = {};
    for (const [f, i] of Object.entries(col)) {
      let v = r[i]; if (v && typeof v === 'object' && !(v instanceof Date)) v = v.result ?? v.text ?? v.richText?.map((t) => t.text).join('') ?? '';
      if (v == null || String(v).trim() === '') continue;
      if (f === 'date' || f === 'joined_on') v = isoDate(v);
      else if (NUM.has(f)) { const n = Number(String(v).replace(/[^\d.+-]/g, '')); if (Number.isNaN(n)) continue; v = n; }
      else if (BOOL.has(f)) v = !/^(0|no|false|n)$/i.test(String(v).trim());
      else if (f === 'event') v = v instanceof Date ? isoDate(v) : String(v).trim();
      else v = String(v).trim();
      o[f] = v;
    }
    if (Object.keys(o).length) out.push(o);
  }
  return out;
}

async function readXlsx(file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const out = {};
  wb.eachSheet((ws) => {
    const kind = KINDS.find((k) => ws.name.trim().toLowerCase() === k || ws.name.trim().toLowerCase() === k.replace(/s$/, ''));
    if (!kind) return;
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row) => { const v = row.values.slice(1); rows.push(v); });
    out[kind] = normalise(kind, rows);
  });
  return out;
}

/** inputs: ['book.xlsx'] or ['members.csv', 'results=/path/scores.csv', …] */
async function readInputs(inputs) {
  const data = {};
  for (const inp of inputs) {
    const m = inp.match(/^(members|courses|events|results|honours)=(.+)$/i);
    const file = m ? m[2] : inp;
    if (!fs.existsSync(file)) throw new Error(`No such file: ${file}`);
    if (/\.xlsx$/i.test(file)) { Object.assign(data, await readXlsx(file)); continue; }
    if (!/\.csv$/i.test(file)) throw new Error(`Unsupported file type (use .csv or .xlsx): ${file}`);
    const kind = m ? m[1].toLowerCase() : KINDS.find((k) => path.basename(file).toLowerCase().startsWith(k.replace(/s$/, '')));
    if (!kind) throw new Error(`Can't tell what ${file} holds: name it members.csv, courses.csv, events.csv, results.csv or honours.csv (or pass kind=path)`);
    data[kind] = normalise(kind, parseCsv(fs.readFileSync(file, 'utf8')));
  }
  return data;
}

module.exports = { readInputs, readXlsx, parseCsv, normalise, KINDS };
