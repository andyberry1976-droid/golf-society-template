'use strict';
const P = require('./points');

/** Order of Merit for a season. Optionally ignore one event (to compute "before the last event" ranks). */
function orderOfMerit(db, seasonId, { excludeEventId = null } = {}) {
  const season = db.prepare('SELECT * FROM seasons WHERE id=?').get(seasonId);
  if (!season) return [];
  const settings = db.prepare("SELECT value FROM settings WHERE key='oom_default_scheme'").get();
  const scheme = P.parseScheme(season.scheme, P.parseScheme(settings && settings.value));
  const rows = db.prepare(`
    SELECT r.user_id, r.points, r.position, r.event_id, u.name, u.nickname, u.status
    FROM results r JOIN events e ON e.id=r.event_id JOIN users u ON u.id=r.user_id
    WHERE e.season_id=? AND e.status='completed' AND e.counts_oom=1 AND (? IS NULL OR e.id!=?)`).all(seasonId, excludeEventId, excludeEventId);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.user_id)) by.set(r.user_id, { user_id: r.user_id, name: r.name, nickname: r.nickname, pts: [], wins: 0, podiums: 0 });
    const o = by.get(r.user_id);
    o.pts.push(r.points);
    if (r.position === 1) o.wins++;
    if (r.position && r.position <= 3) o.podiums++;
  }
  const out = [...by.values()].map((o) => {
    const b = P.bestN(o.pts, scheme.bestN);
    return { user_id: o.user_id, name: o.name, nickname: o.nickname, played: scheme.mode === 'score' ? o.pts.filter((x) => x > 0).length : o.pts.length, wins: o.wins, podiums: o.podiums, total: b.total, counted: b.counted, dropped: b.dropped, rest: b.rest };
  });
  const cmp = scheme.countback ? P.compareCountback : (a, b) => b.total - a.total || b.wins - a.wins || b.podiums - a.podiums;
  out.sort((a, b) => cmp(a, b) || a.name.localeCompare(b.name));
  let rank = 0;
  out.forEach((o, i) => {
    const p = out[i - 1];
    if (!p || cmp(p, o) !== 0) rank = i + 1;
    o.rank = rank;
  });
  return out;
}

/** OoM with movement versus the table before the most recent completed event in the season. */
function orderOfMeritWithMovement(db, seasonId) {
  const now = orderOfMerit(db, seasonId);
  const last = db.prepare(`SELECT e.id FROM events e WHERE e.season_id=? AND e.status='completed' AND e.counts_oom=1
     AND EXISTS (SELECT 1 FROM results r WHERE r.event_id=e.id) ORDER BY e.event_date DESC, e.id DESC LIMIT 1`).get(seasonId);
  if (!last) return { rows: now, lastEventId: null };
  const before = new Map(orderOfMerit(db, seasonId, { excludeEventId: last.id }).map((o) => [o.user_id, o.rank]));
  const nb = before.size;
  for (const o of now) o.moved = before.has(o.user_id) ? before.get(o.user_id) - o.rank : null;
  return { rows: now, lastEventId: last.id, newCount: nb };
}

/** Handicap leaderboard with movement since the latest completed event. */
function handicapLeaderboard(db) {
  const users = db.prepare("SELECT id AS user_id, name, nickname, handicap_index FROM users WHERE status='active' AND handicap_index IS NOT NULL").all();
  const last = db.prepare(`SELECT e.id, e.title FROM events e WHERE e.status='completed' AND e.counts_handicap=1
     AND EXISTS (SELECT 1 FROM results r WHERE r.event_id=e.id) ORDER BY e.event_date DESC, e.id DESC LIMIT 1`).get();
  const prev = new Map();
  if (last) {
    for (const h of db.prepare(`SELECT h.user_id, h.index_before FROM handicap_history h JOIN results r ON r.id=h.result_id WHERE r.event_id=?`).all(last.id)) {
      prev.set(h.user_id, h.index_before);
    }
  }
  for (const u of users) {
    u.prev = prev.has(u.user_id) && prev.get(u.user_id) != null ? prev.get(u.user_id) : u.handicap_index;
    u.change = Math.round((u.handicap_index - u.prev) * 10) / 10;
  }
  const rank = (arr, key) => {
    const s = arr.slice().sort((a, b) => a[key] - b[key] || a.name.localeCompare(b.name));
    return new Map(s.map((u, i) => [u.user_id, i + 1]));
  };
  const nowR = rank(users, 'handicap_index'); const prevR = rank(users, 'prev');
  for (const u of users) { u.rank = nowR.get(u.user_id); u.moved = prevR.get(u.user_id) - u.rank; }
  users.sort((a, b) => a.rank - b.rank);
  return { rows: users, lastEvent: last || null };
}

module.exports = { orderOfMerit, orderOfMeritWithMovement, handicapLeaderboard };
