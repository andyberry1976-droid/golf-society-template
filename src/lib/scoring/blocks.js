'use strict';
/**
 * Generic scoring building blocks (pure functions, no DB). A competition type's config picks one
 * format, an allowance, a ranking/tie-break rule and a points table; see presets.js.
 */
const r = (x) => Math.round(x + 1e-9);

// ---- allowances ------------------------------------------------------------------
function courseHandicap(index, { slope = 113, rating, par }) { return r(index * slope / 113 + ((rating ?? par) - par)); }
function playingHandicap(ch, pct = 100) { return r(ch * pct / 100); }
/** Team handicap: weights applied to the sorted (low->high) players' playing handicaps, e.g. scramble 4-ball [0.25,0.2,0.15,0.1]. */
function teamHandicap(phs, weights) {
  const s = phs.slice().sort((a, b) => a - b);
  return r(s.reduce((t, ph, i) => t + ph * (weights[i] ?? 0), 0));
}
/** Strokes received on a hole of stroke index si (1..18), supporting handicaps > 18 and plus handicaps. */
function strokesOnHole(ph, si, holes = 18) {
  if (ph >= 0) return Math.floor(ph / holes) + (si <= ph % holes ? 1 : 0);
  return si > holes + ph ? -1 : 0; // plus handicap gives back on the easiest holes
}
/** Max per hole cap: { type: 'net_double_bogey' } | { type: 'par_plus', n } | { type: 'fixed', n } */
function capHole(gross, par, strokes, cap) {
  if (gross == null || !cap) return gross;
  const lim = cap.type === 'net_double_bogey' ? par + 2 + strokes : cap.type === 'par_plus' ? par + cap.n : cap.n;
  return Math.min(gross, lim);
}

// ---- formats: per-hole scorers ----------------------------------------------------
function stablefordHole(gross, par, strokes) { return gross == null ? 0 : Math.max(0, 2 + par + strokes - gross); }
function parBogeyHole(gross, par, strokes) { if (gross == null) return -1; const n = gross - strokes; return n < par ? 1 : n === par ? 0 : -1; }

/**
 * Score one card. card: { holes?: [gross|null x18], total?: {gross?, stableford?, net?} }.
 * course: { par, rating, slope, holes?: [{par, si}] }. ph: playing handicap.
 * Returns { gross, net, stableford, parBogey, holes:[{gross,net,pts}] } using hole-by-hole data when present,
 * otherwise the round-total approximations.
 */
function scoreCard(card, course, ph, { cap = null } = {}) {
  if (card.holes && course.holes) {
    const out = { gross: 0, net: 0, stableford: 0, parBogey: 0, holes: [] };
    card.holes.forEach((g0, i) => {
      const h = course.holes[i]; const st = strokesOnHole(ph, h.si, course.holes.length);
      const g = capHole(g0, h.par, st, cap);
      const pts = stablefordHole(g, h.par, st);
      out.gross += g ?? (h.par + 2 + st); out.stableford += pts; out.parBogey += parBogeyHole(g, h.par, st);
      out.holes.push({ gross: g, net: g == null ? null : g - st, pts });
    });
    out.net = out.gross - ph;
    return out;
  }
  const t = card.total || {};
  if (t.gross != null) return { gross: t.gross, net: t.gross - ph, stableford: Math.max(0, 36 + course.par + ph - t.gross), parBogey: null, holes: null };
  if (t.stableford != null) { const g = course.par + ph + 36 - t.stableford; return { gross: g, net: g - ph, stableford: t.stableford, parBogey: null, holes: null }; }
  return { gross: null, net: t.net ?? null, stableford: null, parBogey: null, holes: null };
}

/** Better-ball: best stableford per hole across partners (cards already scored with holes). */
function betterBall(scored) {
  const n = scored[0].holes.length; let pts = 0;
  for (let i = 0; i < n; i++) pts += Math.max(...scored.map((s) => s.holes[i].pts));
  return { stableford: pts };
}
/** Matchplay: per-hole net comparison. Returns { result: 'A'|'B'|'halved', margin, thru, label }. */
function matchplay(aNet, bNet) {
  let diff = 0; let i = 0; const n = aNet.length;
  for (; i < n; i++) {
    if (aNet[i] != null && bNet[i] != null) diff += aNet[i] < bNet[i] ? 1 : aNet[i] > bNet[i] ? -1 : 0;
    if (Math.abs(diff) > n - i - 1) { i++; break; }
  }
  if (!diff) return { result: 'halved', margin: 0, thru: i, label: 'A/S' };
  const left = n - i;
  return { result: diff > 0 ? 'A' : 'B', margin: Math.abs(diff), thru: i, label: left ? `${Math.abs(diff)}&${left}` : `${Math.abs(diff)} up` };
}

// ---- ranking + countback ---------------------------------------------------------
const METRIC = { stableford: { key: 'stableford', lower: false }, stroke_net: { key: 'net', lower: true }, stroke_gross: { key: 'gross', lower: true }, par_bogey: { key: 'parBogey', lower: false } };

/** Sum of a hole slice for countback (last N holes). */
function lastN(holes, n, field) { return holes.slice(-n).reduce((s, h) => s + (h[field] ?? 0), 0); }

/**
 * Rank entries: [{ key, value, holes?, position_in? }]. Competition ranking (1,2,2,4).
 * tieBreak: 'none' | 'countback' (back 9, 6, 3, 1 — only when both have hole data).
 * A manually entered position_in always wins.
 */
function rank(entries, { lower = false, tieBreak = 'none', field = 'pts' } = {}) {
  const better = (a, b) => (lower ? a - b : b - a);
  const cmp = (a, b) => {
    const d = better(a.value, b.value); if (d || tieBreak !== 'countback' || !a.holes || !b.holes) return d;
    for (const n of [9, 6, 3, 1]) { const x = better(lastN(a.holes, n, field), lastN(b.holes, n, field)); if (x) return x; }
    return 0;
  };
  const scored = entries.filter((e) => e.value != null).sort(cmp);
  const pos = new Map(); let rk = 0;
  scored.forEach((e, i) => { if (i === 0 || cmp(scored[i - 1], e) !== 0) rk = i + 1; pos.set(e.key, rk); });
  const out = new Map();
  for (const e of entries) out.set(e.key, e.position_in != null ? e.position_in : (pos.get(e.key) || null));
  return out;
}

// ---- points ----------------------------------------------------------------------
/**
 * points: { mode: 'points'|'score', positions:[...], participation, multiplier, bonuses:[{when,pts}], lastPlace }
 * bonus conditions: 'played', 'stableford>=N', 'birdies' (per birdie), 'last'.
 */
function pointsFor(entry, pos, cfg, { field = 0, multiplier = 1 } = {}) {
  if (cfg.mode === 'score') return (entry.stableford ?? 0) + (entry.bonus || 0);
  let p = Math.round((pos && pos > 0 ? (cfg.positions[pos - 1] || 0) : 0) * multiplier) + (cfg.participation || 0) + (entry.bonus || 0);
  for (const b of cfg.bonuses || []) {
    if (b.when === 'played') p += b.pts;
    else if (b.when === 'birdies') p += b.pts * (entry.birdies || 0);
    else if (b.when === 'last') { if (pos && pos === field && field > 1) p += b.pts; }
    else { const m = /^stableford>=(\d+)$/.exec(b.when); if (m && (entry.stableford ?? -1) >= +m[1]) p += b.pts; }
  }
  return p;
}

module.exports = { courseHandicap, playingHandicap, teamHandicap, strokesOnHole, capHole, stablefordHole, parBogeyHole, scoreCard, betterBall, matchplay, METRIC, rank, pointsFor };
