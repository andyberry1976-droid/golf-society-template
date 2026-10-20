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
module.exports = { PLACE_POINTS, RULES, placePoints, simulate, price, rulesFrom, livePrices };
