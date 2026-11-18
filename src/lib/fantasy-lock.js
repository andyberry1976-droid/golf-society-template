'use strict';
/**
 * Member team lock: logged-in members can pick and change their own team until the first tee time of the
 * season's earliest (non-cancelled) event, in Europe/London time. Worked out from the events calendar on every
 * request (never stored), so moving or adding an event moves the lock. An event without a usable tee time locks at
 * the start of its day. No event in the season = picks stay open.
 */
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Current Europe/London wall-clock time as 'YYYY-MM-DDTHH:MM' (sortable). */
function londonNow(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
/** '2027-01-30T10:16' -> 'Sat 30 Jan 2027, 10:16' */
function fmt(s) {
  const [d, t] = String(s || '').split('T'); if (!DATE_RE.test(d || '') || !TIME_RE.test(t || '')) return '';
  const dt = new Date(d + 'T12:00:00Z');
  const D = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']; const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${D[dt.getUTCDay()]} ${dt.getUTCDate()} ${M[dt.getUTCMonth()]} ${dt.getUTCFullYear()}, ${t}`;
}
/**
 * { at: 'YYYY-MM-DDTHH:MM' | null, text, locked, event: {id, title, event_date, tee_time} | null }
 * `now` is a London wall-clock string (tests pass their own).
 */
function memberLock(db, season, now = londonNow()) {
  const rows = db.prepare(`SELECT e.id, e.title, e.event_date, e.tee_time FROM events e JOIN seasons s ON s.id=e.season_id
    WHERE s.year=? AND e.status<>'cancelled' ORDER BY e.event_date, e.id`).all(season);
  let best = null;
  for (const e of rows) {
    if (!DATE_RE.test(e.event_date || '')) continue;
    const t = String(e.tee_time || '').trim(); const at = `${e.event_date}T${TIME_RE.test(t) ? t : '00:00'}`;
    if (!best || at < best.at) best = { at, event: e };
  }
  if (!best) return { at: null, text: '', locked: false, event: null };
  return { at: best.at, text: fmt(best.at), locked: now >= best.at, event: best.event };
}

module.exports = { memberLock, londonNow, fmt };
