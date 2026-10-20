'use strict';
/**
 * Generic competitions: an event linked to a competition type (event_competitions) is scored by the
 * configurable engine (lib/scoring) from engine_scores (hole-by-hole or totals) into engine_results,
 * each row carrying a snapshot of the rules used. Leagues sum engine_results points.
 */
const E = require('./scoring');

const cardOf = (s) => (s.holes ? { holes: JSON.parse(s.holes) } : s.gross_total != null ? { total: { gross: s.gross_total } } : s.stableford_total != null ? { total: { stableford: s.stableford_total } } : null);
function groupBy(arr, f) { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }

function typeFor(db, eventId) {
  return db.prepare('SELECT t.* FROM event_competitions ec JOIN competition_types t ON t.id=ec.competition_type_id WHERE ec.event_id=?').get(eventId) || null;
}
function courseOf(db, ev) {
  const c = ev.course_id ? db.prepare('SELECT * FROM courses WHERE id=?').get(ev.course_id) : null;
  return c ? { par: c.par, rating: c.rating, slope: c.slope, holes: c.holes ? JSON.parse(c.holes) : null } : { par: 72, rating: 72, slope: 113, holes: null };
}

function computeEvent(db, eventId) {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  const type = typeFor(db, eventId); if (!ev || !type) return 0;
  const cfg = JSON.parse(type.config); const course = courseOf(db, ev);
  const rows = db.prepare('SELECT s.*, u.handicap_index FROM engine_scores s JOIN users u ON u.id=s.user_id WHERE s.event_id=?').all(eventId);
  const phOf = (s) => E.playingHandicap(E.courseHandicap(s.hcp_index ?? s.handicap_index ?? 0, course), cfg.allowance?.pct ?? 100);
  const mult = ev.points_multiplier || 1; const out = [];
  if (cfg.format === 'matchplay') {
    for (const g of groupBy(rows, (r) => r.team_no ?? `solo${r.id}`).values()) {
      if (g.length !== 2 || !g[0].holes || !g[1].holes || !course.holes) { g.forEach((s) => out.push({ s, ph: phOf(s), position: null, points: 0, detail: 'Needs two hole-by-hole cards with the same match number' })); continue; }
      const phs = g.map(phOf); const low = Math.min(...phs);
      const nets = g.map((s, k) => E.scoreCard(cardOf(s), course, cfg.allowance?.difference ? phs[k] - low : phs[k]).holes.map((h) => h.net));
      const m = E.matchplay(nets[0], nets[1]);
      g.forEach((s, k) => { const won = (m.result === 'A' && k === 0) || (m.result === 'B' && k === 1); const pos = m.result === 'halved' || won ? 1 : 2;
        out.push({ s, ph: phs[k], position: pos, points: E.pointsFor(s, pos, cfg.points, { field: 2, multiplier: mult }), detail: m.result === 'halved' ? 'Halved' : (won ? 'Won ' : 'Lost ') + m.label }); });
    }
  } else if (cfg.team) {
    const teams = [...groupBy(rows, (r) => r.team_no ?? `solo${r.id}`).entries()].map(([key, g]) => {
      const phs = g.map(phOf);
      if (cfg.team.type === 'scramble') return { key, ph: E.teamHandicap(phs, cfg.team.weights || []), card: g.map(cardOf).find(Boolean), g, phs };
      const cards = g.map((s, k) => (s.holes && course.holes ? E.scoreCard(cardOf(s), course, phs[k]) : null));
      return { key, ph: null, stableford: cards.length && cards.every(Boolean) ? E.betterBall(cards).stableford : null, g, phs };
    });
    const scored = E.scoreEvent(teams.map((t) => ({ key: t.key, ph: t.ph ?? 0, card: t.card, stableford: t.stableford })), course, cfg, { multiplier: mult });
    for (const t of teams) { const r = scored.find((x) => x.key === t.key); t.g.forEach((s, k) => out.push({ s, ...r, ph: t.ph ?? t.phs[k], detail: `Team ${t.key}` })); }
  } else {
    const scored = E.scoreEvent(rows.map((s) => {
      const h = s.holes ? JSON.parse(s.holes) : null;
      return { key: s.id, ph: phOf(s), card: cardOf(s), position_in: s.position_in, birdies: s.birdies ?? (h && course.holes ? h.filter((g, i) => g != null && g < course.holes[i].par).length : null) };
    }), course, cfg, { multiplier: mult });
    for (const r of scored) out.push({ s: rows.find((x) => x.id === r.key), ...r });
  }
  const snap = JSON.stringify(cfg);
  db.transaction(() => {
    db.prepare('DELETE FROM engine_results WHERE event_id=?').run(eventId);
    const ins = db.prepare(`INSERT INTO engine_results(society_id,event_id,user_id,team_no,playing_handicap,position,points,stableford,net,gross,par_bogey,detail,config_snapshot) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const o of out) ins.run(eventId, o.s.user_id, o.s.team_no ?? null, o.ph ?? null, o.position ?? null, o.points ?? 0, o.stableford ?? null, o.net ?? null, o.gross ?? null, o.parBogey ?? null, o.detail ?? null, snap);
  })();
  return out.length;
}

function results(db, eventId) {
  return db.prepare('SELECT r.*, u.name FROM engine_results r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY r.position IS NULL, r.position, u.name').all(eventId);
}

function league(db, leagueId) {
  const lg = db.prepare('SELECT * FROM leagues WHERE id=?').get(leagueId); if (!lg) return null;
  const cfg = JSON.parse(lg.config);
  const evs = db.prepare(`SELECT e.*, ec.competition_type_id FROM events e JOIN event_competitions ec ON ec.event_id=e.id WHERE e.status!='cancelled' AND EXISTS (SELECT 1 FROM engine_results r WHERE r.event_id=e.id) ORDER BY e.event_date`).all()
    .filter((e) => (!lg.season_id || e.season_id === lg.season_id) && (!cfg.types || cfg.types.includes(e.competition_type_id)) && (!cfg.events || cfg.events.includes(e.id)));
  const ids = new Set(evs.map((e) => e.id));
  const res = db.prepare('SELECT event_id, user_id, points FROM engine_results').all().filter((r) => ids.has(r.event_id)).map((r) => ({ user: r.user_id, event: r.event_id, points: r.points }));
  const names = new Map(db.prepare('SELECT id,name FROM users').all().map((m) => [m.id, m.name]));
  return { league: lg, cfg, events: evs, rows: E.leagueTable(res, { bestN: cfg.bestN }).map((r) => ({ ...r, name: names.get(r.user) })) };
}
module.exports = { computeEvent, results, league, typeFor };
