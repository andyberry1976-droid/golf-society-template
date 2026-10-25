'use strict';
/**
 * Prize money: typed in by an admin per event (placings 1st/2nd/3rd…, nearest the pins, other prizes).
 * Nothing here reads or changes results, the Order of Merit or fantasy; results are only used to suggest winners.
 * Seasons are calendar/season years starting at the `prize_start_season` setting (blank = the current year).
 */
const KINDS = ['place', 'ntp', 'other'];
const MAX_PENCE = 100000000; // 1,000,000.00
const thisYear = () => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(new Date()));

function startSeason(S) {
  const n = Number(String((S && S.prize_start_season) || '').trim());
  return Number.isInteger(n) && n >= 1900 && n <= 2999 ? n : thisYear();
}

/** "25", "25.5", "25.50", "£25.00" → pence; anything else (0, negative, 3 dp, words) → null. */
function parseAmount(v, cur = '£') {
  let s = String(v == null ? '' : v).trim().replace(/,/g, '');
  if (cur && s.startsWith(cur)) s = s.slice(cur.length).trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [w, f = ''] = s.split('.');
  const p = Number(w) * 100 + Number((f + '00').slice(0, 2));
  return p > 0 && p <= MAX_PENCE ? p : null;
}

const fmtMoney = (pence, cur = '£') => {
  const v = Number(pence || 0) / 100;
  return cur + v.toLocaleString('en-GB', { minimumFractionDigits: pence % 100 ? 2 : 0, maximumFractionDigits: 2 });
};

const yearOfEvent = (db, eventId) => {
  const r = db.prepare('SELECT e.id, e.title, e.event_date, e.end_date, COALESCE(s.year, CAST(substr(e.event_date,1,4) AS INTEGER)) AS year FROM events e LEFT JOIN seasons s ON s.id=e.season_id WHERE e.id=?').get(eventId);
  return r || null;
};

/** Years with a prize page: the start season up to this year / the last season with events (never earlier than the start). */
function years(db, S) {
  const start = startSeason(S);
  const r = db.prepare('SELECT MAX(COALESCE(s.year, CAST(substr(e.event_date,1,4) AS INTEGER))) y FROM events e LEFT JOIN seasons s ON s.id=e.season_id').get();
  const last = Math.max(start, thisYear(), Number(r && r.y) || 0);
  const out = []; for (let y = last; y >= start; y--) out.push(y);
  return out;
}
/** The year to show: the one asked for if allowed, else this year (or the start season if that is later). */
function pickYear(db, S, asked) {
  const ys = years(db, S); const n = Number(asked);
  if (ys.includes(n)) return n;
  const t = thisYear();
  return ys.includes(t) ? t : ys[ys.length - 1];
}

function resolveWinner(db, userId, name) {
  const nm = String(name || '').trim().replace(/\s+/g, ' ');
  const uid = String(userId || '').trim();
  if (uid) {
    const u = /^\d+$/.test(uid) ? db.prepare('SELECT id, name FROM users WHERE id=?').get(Number(uid)) : null;
    if (!u) return { error: 'Pick a member from the list' };
    return { user_id: u.id, winner_name: nm || u.name };
  }
  if (!nm) return { error: 'Pick a member or type the winner’s name' };
  if (nm.length > 60) return { error: 'Keep the name to 60 characters' };
  return { user_id: null, winner_name: nm };
}

/** Validate one line. b: {kind, position, label, amount, user_id, winner_name}. */
function validateLine(db, b, cur) {
  const errors = {}; const kind = String(b.kind || '');
  if (!KINDS.includes(kind)) errors.kind = 'Unknown prize type';
  const out = { kind, position: null, label: null };
  if (kind === 'place') {
    const p = String(b.position || '').trim();
    if (!/^\d{1,3}$/.test(p) || Number(p) < 1 || Number(p) > 200) errors.position = 'Position must be a whole number from 1';
    else out.position = Number(p);
  }
  const label = String(b.label || '').trim().replace(/\s+/g, ' ');
  if (label.length > 60) errors.label = 'Keep the label to 60 characters';
  if (kind === 'other' && !label) errors.label = 'Say what the prize is for (e.g. Longest drive)';
  if (kind !== 'place') out.label = label || null;
  const amount = parseAmount(b.amount, cur);
  if (amount == null) errors.amount = 'Amount must be a positive number with up to 2 decimal places';
  out.amount_pence = amount;
  const w = resolveWinner(db, b.user_id, b.winner_name);
  if (w.error) errors.winner = w.error; else Object.assign(out, w);
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, line: out };
}

function checkEventYear(db, S, eventId) {
  const ev = yearOfEvent(db, eventId);
  if (!ev) return { error: 'Event not found', status: 404 };
  const start = startSeason(S);
  if (ev.year < start) return { error: `Prize money starts with the ${start} season`, status: 422, ev };
  return { ev };
}

/** Split pence between n winners: equal shares, any odd pennies go to the first winners. */
function split(pence, n) {
  const base = Math.floor(pence / n); const rem = pence - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
}

/**
 * Add a prize to an event. Placings may name several tied winners (winners: [{user_id, winner_name}]);
 * with split on, the amount is shared between them, otherwise each tied winner gets the full amount.
 */
function addLine(db, S, eventId, b, byUser, cur) {
  const chk = checkEventYear(db, S, eventId);
  if (chk.error) return { ok: false, status: chk.status, errors: { event: chk.error } };
  const raw = Array.isArray(b.winners) && b.winners.length ? b.winners : [{ user_id: b.user_id, winner_name: b.winner_name }];
  const winners = raw.filter((w) => String(w.user_id || '').trim() || String(w.winner_name || '').trim());
  if (!winners.length) winners.push({});
  const checked = winners.map((w) => validateLine(db, { ...b, ...w }, cur));
  const bad = checked.find((c) => !c.ok);
  if (bad) return { ok: false, status: 422, errors: bad.errors };
  const shares = winners.length > 1 && (b.split === '1' || b.split === true) ? split(checked[0].line.amount_pence, winners.length) : checked.map((c) => c.line.amount_pence);
  if (shares.some((p) => p <= 0)) return { ok: false, status: 422, errors: { amount: 'That amount is too small to split' } };
  const ins = db.prepare('INSERT INTO prize_lines(event_id,kind,position,label,amount_pence,user_id,winner_name,created_by) VALUES (?,?,?,?,?,?,?,?)');
  const rows = db.transaction(() => checked.map((c, i) => {
    const l = c.line; const id = ins.run(eventId, l.kind, l.position, l.label, shares[i], l.user_id, l.winner_name, byUser || null).lastInsertRowid;
    return { id, ...l, amount_pence: shares[i] };
  }))();
  return { ok: true, rows, ev: chk.ev };
}

function getLine(db, id) { return db.prepare('SELECT * FROM prize_lines WHERE id=?').get(id); }

function editLine(db, S, id, b, cur) {
  const old = getLine(db, id);
  if (!old) return { ok: false, status: 404, errors: { line: 'Prize not found' } };
  const chk = checkEventYear(db, S, old.event_id);
  if (chk.error) return { ok: false, status: chk.status, errors: { event: chk.error } };
  const c = validateLine(db, { ...b, kind: old.kind }, cur);
  if (!c.ok) return { ok: false, status: 422, errors: c.errors, old };
  const l = c.line;
  db.prepare("UPDATE prize_lines SET position=?, label=?, amount_pence=?, user_id=?, winner_name=?, updated_at=datetime('now') WHERE id=?").run(l.position, l.label, l.amount_pence, l.user_id, l.winner_name, id);
  return { ok: true, old, row: { ...old, ...l }, ev: chk.ev };
}

function deleteLine(db, id) {
  const old = getLine(db, id);
  if (!old) return { ok: false, status: 404 };
  db.prepare('DELETE FROM prize_lines WHERE id=?').run(id);
  return { ok: true, old };
}

const KIND_ORDER = { place: 0, ntp: 1, other: 2 };
const ordinal = (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');

/** Lines for one event, ordered (placings, nearest the pins, others) with a display label; tied placings get "=". */
function eventLines(db, eventId) {
  const rows = db.prepare(`SELECT p.*, u.name AS member_name FROM prize_lines p LEFT JOIN users u ON u.id=p.user_id WHERE p.event_id=?`).all(eventId);
  const placeCount = {}; for (const r of rows) if (r.kind === 'place') placeCount[r.position] = (placeCount[r.position] || 0) + 1;
  return rows.map((r) => ({
    ...r,
    name: r.member_name || r.winner_name,
    tied: r.kind === 'place' && placeCount[r.position] > 1,
    title: r.kind === 'place' ? (placeCount[r.position] > 1 ? '=' : '') + ordinal(r.position)
      : r.kind === 'ntp' ? 'Nearest the pin' + (r.label ? ` (${r.label})` : '') : r.label,
  })).sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.position || 0) - (b.position || 0) || String(a.label || '').localeCompare(String(b.label || ''), 'en', { numeric: true }) || a.id - b.id);
}

/** Events in a season year, oldest first, each with its prize lines and total. */
function seasonEvents(db, year) {
  return db.prepare(`SELECT e.id, e.title, e.event_date, e.end_date, e.status FROM events e LEFT JOIN seasons s ON s.id=e.season_id
      WHERE COALESCE(s.year, CAST(substr(e.event_date,1,4) AS INTEGER))=? ORDER BY e.event_date, e.id`).all(year)
    .map((e) => { const lines = eventLines(db, e.id); return { ...e, lines, total: lines.reduce((s, l) => s + l.amount_pence, 0) }; });
}

/** Season summary: events with prizes, per-player leaderboard (total, prize count; joint positions), grand total. */
function season(db, year) {
  const all = seasonEvents(db, year);
  const events = all.filter((e) => e.lines.length);
  const by = new Map();
  for (const e of events) for (const l of e.lines) {
    const key = l.user_id ? 'u' + l.user_id : 'n' + l.name.toLowerCase();
    const p = by.get(key) || { key, user_id: l.user_id || null, name: l.name, total: 0, count: 0 };
    p.total += l.amount_pence; p.count += 1; by.set(key, p);
  }
  const board = [...by.values()].sort((a, b) => b.total - a.total || b.count - a.count || a.name.localeCompare(b.name));
  board.forEach((p, i) => {
    const prev = board[i - 1];
    p.pos = prev && prev.total === p.total ? prev.pos : i + 1;
  });
  board.forEach((p) => { p.tied = board.filter((q) => q.pos === p.pos).length > 1; });
  return { year, events, board, total: events.reduce((s, e) => s + e.total, 0), prizes: events.reduce((s, e) => s + e.lines.length, 0) };
}

/** Winner suggestions from the event's results (position → members), for pre-filling the admin form. */
function suggestions(db, eventId) {
  const rows = db.prepare('SELECT r.position, u.id AS user_id, u.name FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND r.position IS NOT NULL ORDER BY r.position, u.name').all(eventId);
  const byPos = {}; for (const r of rows) (byPos[r.position] = byPos[r.position] || []).push(r);
  return { rows, byPos };
}

module.exports = { KINDS, startSeason, parseAmount, fmtMoney, years, pickYear, validateLine, addLine, editLine, deleteLine, getLine, eventLines, seasonEvents, season, suggestions, split, yearOfEvent, thisYear };
