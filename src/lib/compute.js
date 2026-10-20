'use strict';
/** Compute an event's results from its competition type config and store them with a config snapshot. */
const E = require('./scoring');

function cardOf(s) {
  if (s.holes) return { holes: JSON.parse(s.holes) };
  if (s.gross_total != null) return { total: { gross: s.gross_total } };
  if (s.stableford_total != null) return { total: { stableford: s.stableford_total } };
  return null;
}
function birdies(holes, course) { return holes && course.holes ? holes.filter((g, i) => g != null && g < course.holes[i].par).length : null; }

function computeEvent(db, eventId) {
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  const type = db.prepare('SELECT * FROM competition_types WHERE id=?').get(ev.competition_type_id);
  const cfg = JSON.parse(type.config);
  const c = ev.course_id ? db.prepare('SELECT * FROM courses WHERE id=?').get(ev.course_id) : null;
  const course = c ? { par: c.par, rating: c.rating, slope: c.slope, holes: c.holes ? JSON.parse(c.holes) : null } : { par: 72, rating: 72, slope: 113, holes: null };
  const rows = db.prepare('SELECT s.*, m.handicap_index FROM scores s JOIN members m ON m.id=s.member_id WHERE s.event_id=?').all(eventId);
  const pct = cfg.allowance?.pct ?? 100;
  const phOf = (s) => E.playingHandicap(E.courseHandicap(s.hcp_index ?? s.handicap_index, course), pct);
  const out = []; // {member_id, team_no, ph, gross, net, stableford, parBogey, position, points, detail}

  if (cfg.format === 'matchplay') {
    const by = groupBy(rows, (r) => r.team_no ?? `solo${r.id}`);
    for (const g of by.values()) {
      if (g.length !== 2 || !g[0].holes || !g[1].holes || !course.holes) { g.forEach((s) => out.push({ s, ph: phOf(s), position: null, points: 0, detail: 'needs two hole-by-hole cards with the same match number' })); continue; }
      const phs = g.map(phOf); const low = Math.min(...phs);
      const nets = g.map((s, k) => E.scoreCard(cardOf(s), course, cfg.allowance?.difference ? phs[k] - low : phs[k]).holes.map((h) => h.net));
      const m = E.matchplay(nets[0], nets[1]);
      g.forEach((s, k) => { const won = (m.result === 'A' && k === 0) || (m.result === 'B' && k === 1); const pos = m.result === 'halved' || won ? 1 : 2;
        out.push({ s, ph: phs[k], position: pos, points: E.pointsFor(s, pos, cfg.points, { field: 2, multiplier: ev.multiplier }), detail: m.result === 'halved' ? 'Halved' : (won ? 'Won ' : 'Lost ') + m.label }); });
    }
  } else if (cfg.team) {
    const teams = [...groupBy(rows, (r) => r.team_no ?? `solo${r.id}`).entries()];
    const entries = teams.map(([key, g]) => {
      const phs = g.map(phOf);
      if (cfg.team.type === 'scramble') {
        const card = g.map(cardOf).find(Boolean); const ph = E.teamHandicap(phs, cfg.team.weights || []);
        return { key, ph, card, members: g, phs };
      }
      const cards = g.map((s, k) => (s.holes && course.holes ? E.scoreCard(cardOf(s), course, phs[k]) : null));
      const stb = cards.every(Boolean) && cards.length ? E.betterBall(cards).stableford : null;
      return { key, ph: null, stableford: stb, members: g, phs };
    });
    const scored = E.scoreEvent(entries.map((t) => ({ key: t.key, ph: t.ph ?? 0, card: t.card, stableford: t.stableford })), course, cfg, { multiplier: ev.multiplier });
    for (const t of entries) { const r = scored.find((x) => x.key === t.key); t.members.forEach((s, k) => out.push({ s, ...r, ph: t.ph ?? t.phs[k], detail: `Team ${t.key}` })); }
  } else {
    const scored = E.scoreEvent(rows.map((s) => {
      const card = cardOf(s); const hb = s.holes ? birdies(JSON.parse(s.holes), course) : null;
      return { key: s.id, ph: phOf(s), card, position_in: s.position_in, birdies: s.birdies ?? hb };
    }), course, cfg, { multiplier: ev.multiplier });
    for (const r of scored) out.push({ s: rows.find((x) => x.id === r.key), ...r });
  }

  const snap = JSON.stringify(cfg);
  db.transaction(() => {
    db.prepare('DELETE FROM results WHERE event_id=?').run(eventId);
    const ins = db.prepare(`INSERT INTO results(society_id,event_id,member_id,team_no,playing_handicap,gross,net,stableford,par_bogey,position,points,detail,config_snapshot) VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const o of out) ins.run(eventId, o.s.member_id, o.s.team_no ?? null, o.ph ?? null, o.gross ?? null, o.net ?? null, o.stableford ?? null, o.parBogey ?? null, o.position ?? null, o.points ?? 0, o.detail ?? null, snap);
    db.prepare("UPDATE events SET status='completed' WHERE id=?").run(eventId);
  })();
  return out.length;
}

function groupBy(arr, f) { const m = new Map(); for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }

/** League table from stored results. */
function league(db, leagueId) {
  const lg = db.prepare('SELECT * FROM leagues WHERE id=?').get(leagueId); const cfg = JSON.parse(lg.config);
  const evs = db.prepare("SELECT * FROM events WHERE status='completed'").all().filter((e) =>
    (!cfg.types || cfg.types.includes(e.competition_type_id)) && (!cfg.events || cfg.events.includes(e.id)) && (!cfg.from || e.event_date >= cfg.from) && (!cfg.to || e.event_date <= cfg.to));
  const ids = new Set(evs.map((e) => e.id));
  const res = db.prepare('SELECT event_id, member_id, points FROM results').all().filter((r) => ids.has(r.event_id)).map((r) => ({ user: r.member_id, event: r.event_id, points: r.points }));
  const names = new Map(db.prepare('SELECT id,name FROM members').all().map((m) => [m.id, m.name]));
  return { league: lg, cfg, events: evs, rows: E.leagueTable(res, { bestN: cfg.bestN }).map((r) => ({ ...r, name: names.get(r.user) })) };
}
module.exports = { computeEvent, league };
