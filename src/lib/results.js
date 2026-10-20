'use strict';
const { recomputeAll } = require('./engine');

function toIntOrNull(v, { min = -9999, max = 9999 } = {}) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < min || n > max) return NaN;
  return n;
}

/**
 * Validate one submitted result row. Returns { ok, value } or { ok:false, error }.
 */
function parseRow(raw) {
  const gross = toIntOrNull(raw.gross, { min: 18, max: 200 });
  const adj = toIntOrNull(raw.adjusted_gross, { min: 18, max: 200 });
  const stb = toIntOrNull(raw.stableford, { min: 0, max: 80 });
  const pos = toIntOrNull(raw.position, { min: 1, max: 200 });
  const bonus = toIntOrNull(raw.bonus, { min: -100, max: 1000 });
  for (const [k, v] of Object.entries({ gross, adj, stb, pos, bonus })) if (Number.isNaN(v)) return { ok: false, error: `Invalid value for ${k}` };
  const note = (raw.note || '').toString().trim().slice(0, 120) || null;
  return { ok: true, value: { gross, adjusted_gross: adj, stableford_in: stb, position_in: pos, bonus: bonus || 0, note } };
}

/**
 * Replace the results of an event. rows: [{ user_id, gross, adjusted_gross, stableford, position, bonus, note }]
 * Marks the event completed, recomputes handicaps, positions, points and honours.
 */
function saveResults(db, eventId, rows, { complete = true } = {}) {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  if (!event) throw Object.assign(new Error('Event not found'), { code: 'NOT_FOUND' });
  const parsed = [];
  const seen = new Set();
  for (const r of rows) {
    const uid = Number(r.user_id);
    if (!Number.isInteger(uid) || seen.has(uid)) continue;
    if (!db.prepare("SELECT 1 FROM users WHERE id=? AND status='active'").get(uid)) throw Object.assign(new Error('Unknown or inactive player in results'), { code: 'INVALID' });
    const p = parseRow(r);
    if (!p.ok) throw Object.assign(new Error(p.error), { code: 'INVALID' });
    const v = p.value;
    if (v.gross == null && v.stableford_in == null && v.position_in == null && v.adjusted_gross == null) {
      throw Object.assign(new Error('Each player needs a gross score, stableford points or a position'), { code: 'INVALID', userId: uid });
    }
    seen.add(uid);
    parsed.push({ uid, ...v });
  }
  db.transaction(() => {
    const keep = parsed.map((p) => p.uid);
    const existing = db.prepare('SELECT user_id FROM results WHERE event_id=?').all(eventId).map((r) => r.user_id);
    for (const uid of existing) if (!keep.includes(uid)) db.prepare('DELETE FROM results WHERE event_id=? AND user_id=?').run(eventId, uid);
    const up = db.prepare(`INSERT INTO results(event_id,user_id,gross,adjusted_gross,stableford_in,position_in,bonus,note)
      VALUES (@event_id,@uid,@gross,@adjusted_gross,@stableford_in,@position_in,@bonus,@note)
      ON CONFLICT(event_id,user_id) DO UPDATE SET gross=excluded.gross, adjusted_gross=excluded.adjusted_gross,
        stableford_in=excluded.stableford_in, position_in=excluded.position_in, bonus=excluded.bonus, note=excluded.note`);
    for (const p of parsed) up.run({ event_id: eventId, ...p });
    const inField = db.prepare('INSERT OR IGNORE INTO event_players(event_id,user_id) VALUES (?,?)');
    for (const p of parsed) inField.run(eventId, p.uid); // anyone with a score is in the field
    if (complete && parsed.length) db.prepare("UPDATE events SET status='completed' WHERE id=? AND status!='cancelled'").run(eventId);
    if (!parsed.length && event.status === 'completed') db.prepare("UPDATE events SET status='scheduled' WHERE id=?").run(eventId);
    recomputeAll(db);
  })();
  return { saved: parsed.length };
}

module.exports = { saveResults, parseRow };
