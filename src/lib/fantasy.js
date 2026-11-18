'use strict';
// Fantasy League 2027 scoring rules (no team picking yet) and the 2026 simulation used to set player prices.
const PLACE_POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]; // 1st..10th
const RULES = { budget: 50, squad: 5, beatHandicap: 3, beatHandicapAt: 36, birdie: 2, played: 3, longestDrive: 5, woodenSpoon: -5 };

/** Points for a finishing position shared by `tied` players: the average of the places they cover. */
function placePoints(position, tied = 1, places = PLACE_POINTS) {
  let s = 0; for (let p = position; p < position + tied; p++) s += places[p - 1] || 0;
  return s / tied;
}

/** Simulate one season: every completed round with results scores as one event. Returns [{user_id,name,points,rounds}]. */
function simulate(db, year, R = RULES, places = PLACE_POINTS) {
  const evs = db.prepare(`SELECT e.id FROM events e JOIN seasons s ON s.id=e.season_id WHERE s.year=? AND e.status='completed'
    AND EXISTS (SELECT 1 FROM results r WHERE r.event_id=e.id AND r.position IS NOT NULL) ORDER BY e.event_date, e.id`).all(year);
  const tot = new Map();
  for (const { id } of evs) {
    const rows = db.prepare('SELECT r.user_id, r.position, r.stableford, u.name FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND r.position IS NOT NULL').all(id);
    const cnt = {}; for (const r of rows) cnt[r.position] = (cnt[r.position] || 0) + 1;
    const last = Math.max(...rows.map((r) => r.position));
    for (const r of rows) {
      let p = placePoints(r.position, cnt[r.position], places) + R.played;
      if (r.stableford != null && r.stableford >= R.beatHandicapAt) p += R.beatHandicap;
      if (r.position === last && rows.length > 1) p += R.woodenSpoon;
      const t = tot.get(r.user_id) || { user_id: r.user_id, name: r.name, points: 0, rounds: 0 };
      t.points += p; t.rounds += 1; tot.set(r.user_id, t);
    }
  }
  return [...tot.values()].map((t) => ({ ...t, points: Math.round(t.points * 10) / 10 })).sort((a, b) => b.points - a.points || a.name.localeCompare(b.name));
}

/** Points -> price: £4m..£15m in £0.5m steps on a curve that makes the stars expensive. */
function price(points, maxPoints, { lo = 4, hi = 15, curve = 0.7 } = {}) {
  const x = maxPoints > 0 ? Math.max(0, points) / maxPoints : 0;
  return Math.round((lo + (hi - lo) * Math.pow(x, curve)) * 2) / 2;
}
/** Per-society rules: settings.fantasy_rules JSON overrides any of RULES plus `places` (points for 1st, 2nd…). */
function rulesFrom(settings = {}) {
  let o = {}; try { o = JSON.parse(settings.fantasy_rules || '{}') || {}; } catch { o = {}; }
  const R = { ...RULES }; for (const k of Object.keys(RULES)) if (Number.isFinite(+o[k])) R[k] = +o[k];
  const places = Array.isArray(o.places) && o.places.length ? o.places.map((n) => +n || 0) : PLACE_POINTS;
  return { R, places, season: o.season || null };
}
/** Prices generated from the data: last completed season's simulated points, small samples pulled to the median. */
function livePrices(db, year, { R = RULES, places = PLACE_POINTS, lo = 3, hi = 13 } = {}) {
  const sim = simulate(db, year, R, places); if (!sim.length) return null;
  const sorted = sim.map((p) => p.points).sort((a, b) => a - b); const med = sorted[Math.floor(sorted.length / 2)] || 0;
  const eff = (p) => (p.rounds <= 2 ? (p.points * p.rounds + med * 3) / (p.rounds + 3) : p.points);
  const max = Math.max(0, ...sim.map(eff));
  const players = sim.map((p) => ({ user_id: p.user_id, name: p.name, price: price(eff(p), max, { lo, hi, curve: 0.9 }), points: p.points, rounds: p.rounds }))
    .sort((a, b) => b.price - a.price || b.points - a.points || a.name.localeCompare(b.name));
  return { season: year + 1, basedOn: year, players };
}
/** One event's fantasy points per golfer (user_id -> points): place points (top 10, ties averaged) + playing + beat handicap
 *  + birdies (Birdie League entry) + wooden spoon. Nearest the pin, blobs and match play never score. */
function eventPoints(db, eventId, R = RULES, places = PLACE_POINTS) {
  const rows = db.prepare('SELECT user_id, position, stableford FROM results WHERE event_id=? AND position IS NOT NULL').all(eventId);
  const out = new Map(); if (!rows.length) return out;
  const cnt = {}; for (const r of rows) cnt[r.position] = (cnt[r.position] || 0) + 1;
  const last = Math.max(...rows.map((r) => r.position));
  let bird = new Map();
  try { bird = new Map(db.prepare("SELECT user_id, value FROM comp_scores WHERE comp='birdie' AND event_id=?").all(eventId).map((b) => [b.user_id, b.value || 0])); } catch { /* no birdie table */ }
  for (const r of rows) {
    let p = placePoints(r.position, cnt[r.position], places) + R.played;
    if (r.stableford != null && r.stableford >= R.beatHandicapAt) p += R.beatHandicap;
    if (r.position === last && rows.length > 1) p += R.woodenSpoon;
    p += R.birdie * (bird.get(r.user_id) || 0);
    out.set(r.user_id, p);
  }
  return out;
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const r1 = (n) => Math.round(n * 10) / 10;

/** The season's months (from the season row's dates, else Jan–Dec): [{key:'2027-03', label:'Mar'}]. */
function seasonMonths(db, year) {
  const s = db.prepare('SELECT start_date, end_date FROM seasons WHERE year=? ORDER BY id LIMIT 1').get(year);
  let a = `${year}-01`; let b = `${year}-12`;
  if (s && s.start_date && s.end_date && s.start_date <= s.end_date) { a = s.start_date.slice(0, 7); b = s.end_date.slice(0, 7); }
  const out = []; let [y, m] = a.split('-').map(Number);
  while (`${y}-${String(m).padStart(2, '0')}` <= b && out.length < 24) { out.push({ key: `${y}-${String(m).padStart(2, '0')}`, label: MON[m - 1] + (String(y) !== String(year) ? ` ${String(y).slice(2)}` : '') }); if (++m > 12) { m = 1; y++; } }
  return out;
}

/**
 * Monthly fantasy standings for a season. Squads are fixed (no transfers), so each month uses the squad as entered; the
 * captain scores double. An event counts in the month it starts. Months with no scored events yet are null (shown as –).
 * Returns { months, grid:[{team, months:[pts|null], total, pos}], squads:[{team, players:[{name, captain, months, total}]}] }.
 */
function monthly(db, season, teams, R = RULES, places = PLACE_POINTS) {
  const months = seasonMonths(db, season); const idx = new Map(months.map((m, i) => [m.key, i]));
  const evs = db.prepare(`SELECT e.id, e.event_date FROM events e JOIN seasons s ON s.id=e.season_id WHERE s.year=? AND e.status='completed'
    AND EXISTS (SELECT 1 FROM results r WHERE r.event_id=e.id AND r.position IS NOT NULL) ORDER BY e.event_date, e.id`).all(season);
  const byUid = new Map(); const byName = new Map(); const played = new Set();
  const names = new Map(db.prepare('SELECT id, name FROM users').all().map((u) => [u.id, String(u.name).trim().toLowerCase()]));
  for (const e of evs) {
    const mi = idx.get(String(e.event_date).slice(0, 7)); if (mi == null) continue; played.add(mi);
    for (const [uid, p] of eventPoints(db, e.id, R, places)) {
      const a = byUid.get(uid) || Array(months.length).fill(0); a[mi] += p; byUid.set(uid, a);
      const n = names.get(uid); if (n) byName.set(n, a);
    }
  }
  const zero = () => months.map((m, i) => (played.has(i) ? 0 : null));
  const squads = teams.map((t) => {
    const players = t.picks.map((p) => {
      const base = (p.user_id && byUid.get(p.user_id)) || byName.get(String(p.name).trim().toLowerCase());
      const captain = p.name === t.captain; const mult = captain ? 2 : 1;
      const ms = zero().map((v, i) => (v == null ? null : r1((base ? base[i] : 0) * mult)));
      return { name: p.name, user_id: p.user_id || null, price: p.price, captain, months: ms, total: r1(ms.reduce((s, v) => s + (v || 0), 0)) };
    });
    return { team: t, players };
  });
  const grid = squads.map((s) => {
    const ms = zero().map((v, i) => (v == null ? null : r1(s.players.reduce((a, p) => a + (p.months[i] || 0), 0))));
    return { team: s.team, months: ms, total: r1(ms.reduce((a, v) => a + (v || 0), 0)) };
  }).sort((a, b) => b.total - a.total || a.team.team_name.localeCompare(b.team.team_name));
  grid.forEach((g, i) => { g.pos = i && grid[i - 1].total === g.total ? grid[i - 1].pos : i + 1; });
  grid.forEach((g, i) => { g.tied = grid.some((o, j) => j !== i && o.pos === g.pos); });
  return { months, grid, squads, scored: played.size > 0 };
}
// Logged-in members may pick (and change) their own team only for this Fantasy League season.
const MEMBER_TEAM_SEASON = 2027;
module.exports = { MEMBER_TEAM_SEASON, PLACE_POINTS, RULES, placePoints, simulate, price, rulesFrom, livePrices, eventPoints, seasonMonths, monthly };
