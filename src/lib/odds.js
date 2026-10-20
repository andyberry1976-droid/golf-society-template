'use strict';
/**
 * Fun odds for the next upcoming event (feature `odds`). Worked out on every page view from the
 * recorded scores, so they move when the field or the scores change.
 *
 * Model, per player in the field:
 *   - form: this season's stableford scores, most recent counting most (each older round weighs 0.85x);
 *   - shrinkage: few rounds are pulled toward the field's average (as if they'd played 3 extra average rounds);
 *   - spread: their own up-and-down (standard deviation), also pulled toward the society-wide spread;
 *   - no rounds this season: last two seasons' average (pulled harder to the field), else field average − 2 with a wide spread.
 * Then 20,000 simulated rounds (normal distribution per player, ties shared) give each player's win
 * chance; a 10% bookie margin is added (about 115–120% once prices are rounded down) and the price is rounded to the nearest standard fraction at or
 * below the fair price (bookies round in their own favour). Seeded, so the odds don't jump on refresh.
 */
const LADDER = ['1/10', '1/8', '1/6', '1/5', '2/9', '1/4', '2/7', '1/3', '4/11', '2/5', '4/9', '1/2', '8/15', '4/7', '8/13', '4/6', '8/11', '4/5', '5/6', '10/11', 'Evens',
  '11/10', '6/5', '5/4', '11/8', '6/4', '13/8', '7/4', '15/8', '2/1', '9/4', '5/2', '11/4', '3/1', '10/3', '7/2', '4/1', '9/2', '5/1', '11/2', '6/1', '13/2', '7/1', '15/2',
  '8/1', '17/2', '9/1', '10/1', '11/1', '12/1', '14/1', '16/1', '18/1', '20/1', '22/1', '25/1', '28/1', '33/1', '40/1', '50/1', '66/1', '80/1', '100/1', '125/1', '150/1', '200/1', '250/1', '500/1'];
const val = (f) => (f === 'Evens' ? 1 : f.split('/').reduce((a, b) => a / b));
const LADDER_V = LADDER.map(val);

/** odds-against (decimal minus 1) → standard fraction at or below it. */
function toFraction(against) {
  let pick = LADDER[0];
  for (let i = 0; i < LADDER.length; i++) if (LADDER_V[i] <= against + 1e-9) pick = LADDER[i];
  return pick;
}

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
function gauss(r) { let u = 0; while (!u) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** The next event that should show odds: earliest scheduled, today or later, no results yet. */
function nextEvent(db, today) {
  return db.prepare(`SELECT e.* FROM events e WHERE e.status='scheduled' AND e.event_date>=? AND NOT EXISTS (SELECT 1 FROM results r WHERE r.event_id=e.id)
    ORDER BY e.event_date, e.id LIMIT 1`).get(today) || null;
}

function compute(db, event, { sims = 20000, margin = 1.10 } = {}) {
  const field = require('./field').list(db, event.id);
  if (field.length < 2) return null;
  const season = db.prepare('SELECT * FROM seasons WHERE id=?').get(event.season_id);
  const year = season ? season.year : Number(event.event_date.slice(0, 4));
  const scores = db.prepare(`SELECT r.user_id, r.stableford, e.event_date, s.year FROM results r JOIN events e ON e.id=r.event_id JOIN seasons s ON s.id=e.season_id
    WHERE e.status='completed' AND r.stableford IS NOT NULL AND s.year BETWEEN ? AND ? AND e.event_date < ? ORDER BY e.event_date DESC, e.id DESC`).all(year - 2, year, event.event_date);
  const thisYear = scores.filter((s) => s.year === year);
  const by = (list) => { const m = new Map(); for (const s of list) { if (!m.has(s.user_id)) m.set(s.user_id, []); m.get(s.user_id).push(s.stableford); } return m; };
  const cur = by(thisYear); const past = by(scores.filter((s) => s.year < year));
  const all = thisYear.map((s) => s.stableford);
  const globalMean = all.length ? mean(all) : 30;
  const globalSd = all.length > 2 ? Math.sqrt(mean(all.map((x) => (x - globalMean) ** 2))) : 6;
  // field strength: the average of the field's own season averages (players with rounds)
  const fieldAvgs = field.map((p) => cur.get(p.id)).filter(Boolean).map(mean);
  const fieldMean = fieldAvgs.length ? mean(fieldAvgs) : globalMean;
  const K = 3;
  const players = field.map((p) => {
    const xs = cur.get(p.id) || [];
    let mu; let sd; let basis;
    if (xs.length) {
      const w = xs.map((_, i) => 0.85 ** i); const W = w.reduce((a, b) => a + b, 0);
      const wm = xs.reduce((a, x, i) => a + x * w[i], 0) / W;
      const wv = xs.reduce((a, x, i) => a + w[i] * (x - wm) ** 2, 0) / W;
      mu = (xs.length * wm + K * fieldMean) / (xs.length + K);
      sd = Math.sqrt((xs.length * wv + K * globalSd ** 2) / (xs.length + K));
      basis = `${xs.length} round${xs.length > 1 ? 's' : ''} this season, avg ${mean(xs).toFixed(1)}`;
    } else if ((past.get(p.id) || []).length) {
      const ps = past.get(p.id);
      mu = (ps.length * mean(ps) + 2 * K * (fieldMean - 1)) / (ps.length + 2 * K);
      sd = globalSd * 1.15; basis = `no rounds this season; ${ps.length} in ${year - 2}–${year - 1}, avg ${mean(ps).toFixed(1)}`;
    } else { mu = fieldMean - 2; sd = globalSd * 1.25; basis = 'no recent rounds'; }
    return { id: p.id, name: p.name, status: p.status, hcp: p.handicap_index, mu, sd: Math.max(3, sd), basis, wins: 0 };
  });
  // seeded Monte Carlo: same inputs → same odds
  let seed = 2166136261; for (const p of players) seed = Math.imul(seed ^ Math.round(p.mu * 100 + p.sd * 10 + p.id), 16777619);
  const r = rng(seed); const n = players.length; const sc = new Array(n);
  for (let s = 0; s < sims; s++) {
    let best = -Infinity; let tied = 0;
    for (let i = 0; i < n; i++) { sc[i] = Math.round(players[i].mu + players[i].sd * gauss(r)); if (sc[i] > best) { best = sc[i]; tied = 1; } else if (sc[i] === best) tied++; }
    for (let i = 0; i < n; i++) if (sc[i] === best) players[i].wins += 1 / tied;
  }
  for (const p of players) {
    p.prob = Math.max(p.wins / sims, 0.001);
    const implied = Math.min(p.prob * margin, 0.95);
    p.odds = toFraction(1 / implied - 1);
    p.oddsValue = val(p.odds);
  }
  players.sort((a, b) => a.oddsValue - b.oddsValue || b.prob - a.prob || a.name.localeCompare(b.name));
  return { event, players, fieldMean, margin, sims };
}

module.exports = { compute, nextEvent, toFraction, LADDER };
