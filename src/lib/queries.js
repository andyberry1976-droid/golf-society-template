'use strict';
const { formatInfo } = require('./formats');

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function seasons(db) {
  return db.prepare('SELECT * FROM seasons ORDER BY year DESC, start_date DESC').all();
}

function currentSeason(db) {
  const t = today();
  return db.prepare('SELECT * FROM seasons WHERE start_date<=? AND end_date>=? ORDER BY start_date DESC LIMIT 1').get(t, t)
    || db.prepare("SELECT * FROM seasons WHERE status='open' ORDER BY start_date DESC LIMIT 1").get()
    || db.prepare('SELECT * FROM seasons ORDER BY start_date DESC LIMIT 1').get();
}

function pickSeason(db, id) {
  if (id) { const s = db.prepare('SELECT * FROM seasons WHERE id=?').get(Number(id)); if (s) return s; }
  return currentSeason(db);
}

const EVENT_SELECT = `SELECT e.*, c.name AS course_name, c.tee AS course_tee, c.par AS course_par, c.rating AS course_rating, c.slope AS course_slope,
  s.name AS season_name, hc.name AS honour_name,
  (SELECT COUNT(*) FROM rsvps r WHERE r.event_id=e.id AND r.status='going') AS going,
  (SELECT COUNT(*) FROM rsvps r WHERE r.event_id=e.id AND r.status='waitlist') AS waitlist,
  (SELECT COUNT(*) FROM results r WHERE r.event_id=e.id) AS result_count
  FROM events e LEFT JOIN courses c ON c.id=e.course_id JOIN seasons s ON s.id=e.season_id
  LEFT JOIN honour_categories hc ON hc.id=e.honour_category_id`;

function decorate(e) {
  if (!e) return e;
  const f = formatInfo(e.format);
  e.format_label = f.label; e.format_cls = f.cls;
  e.full = e.capacity != null && e.going >= e.capacity;
  e.spaces_left = e.capacity != null ? Math.max(0, e.capacity - e.going) : null;
  e.pct = e.capacity ? Math.min(100, Math.round(e.going / e.capacity * 100)) : null;
  return e;
}

function getEvent(db, id) {
  return decorate(db.prepare(EVENT_SELECT + ' WHERE e.id=?').get(id));
}

function upcomingEvents(db, limit = 50) {
  return db.prepare(EVENT_SELECT + " WHERE e.status IN ('scheduled','cancelled') AND e.event_date>=? ORDER BY e.event_date, e.tee_time LIMIT ?").all(today(), limit).map(decorate);
}

function pastEvents(db, { seasonId = null, limit = 100 } = {}) {
  return db.prepare(EVENT_SELECT + ` WHERE (e.status='completed' OR (e.status='scheduled' AND e.event_date<?))
    AND (? IS NULL OR e.season_id=?) ORDER BY e.event_date DESC, e.id DESC LIMIT ?`).all(today(), seasonId, seasonId, limit).map(decorate);
}

function myRsvps(db, userId) {
  const m = new Map();
  if (!userId) return m;
  for (const r of db.prepare('SELECT * FROM rsvps WHERE user_id=?').all(userId)) m.set(r.event_id, r);
  return m;
}

function eventResults(db, eventId) {
  return db.prepare(`SELECT r.*, u.name, u.nickname FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=?
    ORDER BY (r.position IS NULL), r.position, r.stableford DESC, r.net, u.name`).all(eventId);
}

function latestResultEvent(db) {
  const e = db.prepare(EVENT_SELECT + ` WHERE e.status='completed' AND EXISTS (SELECT 1 FROM results r WHERE r.event_id=e.id)
    ORDER BY e.event_date DESC, e.id DESC LIMIT 1`).get();
  return decorate(e);
}

function activeMembers(db) {
  return db.prepare("SELECT id, name, nickname, handicap_index, role FROM users WHERE status='active' ORDER BY name").all();
}

function listCourses(db) {
  return db.prepare('SELECT * FROM courses ORDER BY name, tee').all();
}

function audit(db, userId, action, detail) {
  db.prepare('INSERT INTO audit_log(user_id,action,detail) VALUES (?,?,?)').run(userId || null, action, detail ? String(detail).slice(0, 500) : null);
}

module.exports = { today, seasons, currentSeason, pickSeason, getEvent, upcomingEvents, pastEvents, myRsvps, eventResults, latestResultEvent, activeMembers, listCourses, audit, decorate, EVENT_SELECT };
