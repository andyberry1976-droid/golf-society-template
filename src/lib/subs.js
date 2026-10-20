'use strict';
/** Membership subs: one row per (season, member). users.subs_paid mirrors the current season for older views. */
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function currentSeasonId(db) {
  const s = require('./queries').currentSeason(db); return s ? s.id : null;
}
function get(db, seasonId, userId) {
  return db.prepare('SELECT * FROM subs WHERE season_id=? AND user_id=?').get(seasonId, userId) || null;
}
/** Members with their subs row for a season. Active members always; disabled ones only if they have a row. */
function list(db, seasonId) {
  return db.prepare(`SELECT u.id user_id, u.name, u.nickname, u.status, s.paid, s.paid_on, s.amount, s.note, s.updated_at
    FROM users u LEFT JOIN subs s ON s.user_id=u.id AND s.season_id=?
    WHERE u.status='active' OR s.user_id IS NOT NULL ORDER BY u.name`).all(seasonId)
    .map((r) => ({ ...r, paid: r.paid ? 1 : 0 }));
}
function counts(rows) {
  const paid = rows.filter((r) => r.paid).length;
  return { paid, unpaid: rows.length - paid, total: rows.length, collected: rows.reduce((a, r) => a + (r.paid && r.amount ? r.amount : 0), 0) };
}
function clean(v) {
  const out = { paid: v.paid ? 1 : 0 };
  out.paid_on = v.paid_on && ISO.test(String(v.paid_on)) ? String(v.paid_on) : null;
  const a = v.amount === '' || v.amount == null ? null : Number(v.amount);
  out.amount = a != null && Number.isFinite(a) && a >= 0 && a <= 10000 ? Math.round(a * 100) / 100 : null;
  out.note = v.note ? String(v.note).trim().slice(0, 200) || null : null;
  return out;
}
const same = (a, b) => !!a && a.paid === b.paid && (a.paid_on || null) === b.paid_on && (a.amount ?? null) === b.amount && (a.note || null) === b.note;

/** Set one member's subs for a season. Returns { changed, before, after }. Audits every change. */
function set(db, seasonId, userId, values, { actorId = null, audit = null, source = 'admin' } = {}) {
  const before = get(db, seasonId, userId);
  const after = clean(values);
  if (same(before, after)) return { changed: false, before, after };
  db.prepare(`INSERT INTO subs(season_id,user_id,paid,paid_on,amount,note,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,datetime('now'))
    ON CONFLICT(season_id,user_id) DO UPDATE SET paid=excluded.paid,paid_on=excluded.paid_on,amount=excluded.amount,note=excluded.note,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .run(seasonId, userId, after.paid, after.paid_on, after.amount, after.note, actorId);
  if (seasonId === currentSeasonId(db)) db.prepare('UPDATE users SET subs_paid=? WHERE id=?').run(after.paid, userId);
  if (audit) {
    const u = db.prepare('SELECT name FROM users WHERE id=?').get(userId);
    const sn = db.prepare('SELECT name FROM seasons WHERE id=?').get(seasonId);
    audit('subs_set', `${sn ? sn.name : seasonId} ${u ? u.name : userId}: ${before ? (before.paid ? 'paid' : 'unpaid') : 'none'} → ${after.paid ? 'paid' : 'unpaid'}${after.paid_on ? ' on ' + after.paid_on : ''}${after.amount != null ? ' £' + after.amount : ''}${after.note ? ' (' + after.note + ')' : ''} [${source}]`);
  }
  return { changed: true, before, after };
}

/**
 * Apply a list of { name, paid, note } (member names already resolved) to a season. Idempotent: rows that already
 * match are left alone; a paid date/amount someone entered by hand is kept. Members not on the list are not touched.
 */
function applyList(db, seasonId, entries, { actorId = null, audit = null, source = 'list' } = {}) {
  const byName = new Map(db.prepare('SELECT id,name FROM users').all().map((u) => [u.name.toLowerCase(), u.id]));
  const out = { changed: [], unchanged: [], missing: [] };
  db.transaction(() => {
    for (const e of entries) {
      const id = byName.get(String(e.member).toLowerCase());
      if (!id) { out.missing.push(e.member); continue; }
      const cur = get(db, seasonId, id);
      const keep = cur && !!cur.paid === !!e.paid ? { paid_on: cur.paid_on, amount: cur.amount } : {};
      const note = cur && cur.note && !!cur.paid === !!e.paid ? cur.note : (e.note || null);
      const r = set(db, seasonId, id, { paid: e.paid, ...keep, note }, { actorId, audit, source });
      (r.changed ? out.changed : out.unchanged).push(e.member);
    }
  })();
  return out;
}

async function exportWorkbook(db, seasonId, { societyName = 'Society' } = {}) {
  const ExcelJS = require('exceljs');
  const season = db.prepare('SELECT * FROM seasons WHERE id=?').get(seasonId);
  const rows = list(db, seasonId); const k = counts(rows);
  const wb = new ExcelJS.Workbook(); wb.creator = societyName;
  const ws = wb.addWorksheet('Subs ' + (season ? season.name : ''), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ header: 'Member', key: 'name', width: 26 }, { header: 'Nickname', key: 'nickname', width: 16 }, { header: 'Status', key: 'st', width: 9 },
    { header: 'Paid', key: 'paid', width: 8 }, { header: 'Date paid', key: 'paid_on', width: 12 }, { header: 'Amount (£)', key: 'amount', width: 11 }, { header: 'Note', key: 'note', width: 44 }];
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const row = ws.addRow({ name: r.name, nickname: r.nickname || '', st: r.status === 'active' ? 'Active' : 'Disabled', paid: r.paid ? 'Yes' : 'No',
      paid_on: r.paid_on ? new Date(r.paid_on + 'T12:00:00Z') : null, amount: r.amount, note: r.note || '' });
    row.getCell('paid_on').numFmt = 'dd/mm/yyyy'; row.getCell('amount').numFmt = '0.00';
    row.getCell('paid').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: r.paid ? 'FFD9FBE9' : 'FFFFE3EC' } };
  }
  ws.addRow([]); ws.addRow([`Paid ${k.paid} · Unpaid ${k.unpaid} · Total ${k.total}${k.collected ? ' · Collected £' + k.collected.toFixed(2) : ''}`]).font = { bold: true };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { list, counts, get, set, applyList, exportWorkbook, currentSeasonId, clean };
