'use strict';
/**
 * WHS-style handicap maths (pure functions, no DB). See README "Handicap system" for the
 * list of simplifications versus the full World Handicap System rules.
 */

// number of differentials available -> [how many lowest to average, adjustment]
const WHS_TABLE = {
  3: [1, -2.0], 4: [1, -1.0], 5: [1, 0], 6: [2, -1.0], 7: [2, 0], 8: [2, 0],
  9: [3, 0], 10: [3, 0], 11: [3, 0], 12: [4, 0], 13: [4, 0], 14: [4, 0],
  15: [5, 0], 16: [5, 0], 17: [6, 0], 18: [6, 0], 19: [7, 0], 20: [8, 0],
};

/** Round half up to 1dp (WHS rounds .5 up, towards the higher/worse number). */
function round1(x) {
  return Math.floor(x * 10 + 0.5 + 1e-9) / 10;
}

/** Score differential = (113 / slope) * (AGS - course rating - PCC) */
function scoreDifferential({ ags, rating, slope, pcc = 0 }) {
  if (!(slope > 0)) throw new Error('slope must be > 0');
  return round1((113 / slope) * (ags - rating - pcc));
}

/**
 * Handicap index from a chronological list of differentials (oldest first).
 * Uses the most recent 20. Returns null when fewer than 3 rounds are available.
 */
function indexFromDifferentials(diffs, { maxIndex = 54 } = {}) {
  const last = diffs.slice(-20);
  const rule = WHS_TABLE[last.length];
  if (!rule) return null;
  const [n, adj] = rule;
  const best = last.slice().sort((a, b) => a - b).slice(0, n);
  const avg = best.reduce((s, d) => s + d, 0) / n;
  return Math.min(maxIndex, round1(avg + adj));
}

/**
 * Optional soft & hard caps against the player's "low index" (lowest index in the previous 365 days).
 * Soft cap: any rise above low+3.0 is halved. Hard cap: never more than low+5.0 above low.
 */
function applyCaps(calc, lowIndex, { soft = true, hard = true } = {}) {
  if (lowIndex == null || calc == null) return calc;
  let out = calc;
  if (soft && out > lowIndex + 3) out = lowIndex + 3 + (out - lowIndex - 3) * 0.5;
  if (hard && out > lowIndex + 5) out = lowIndex + 5;
  return round1(out);
}

/** Course handicap = index * slope/113 + (course rating - par), rounded to a whole number. */
function courseHandicap(index, { slope, rating, par }) {
  return Math.round(index * slope / 113 + (rating - par) + 1e-9);
}

/** Playing handicap = course handicap * allowance %, rounded. */
function playingHandicap(ch, allowancePct = 95) {
  return Math.round(ch * allowancePct / 100 + 1e-9);
}

/** Net score = gross - playing handicap */
function netScore(gross, ph) {
  return gross - ph;
}

/** Approximate stableford from a gross total (no hole-by-hole data): 36 + par + PH - gross, floored at 0. */
function stablefordFromGross(gross, par, ph) {
  return Math.max(0, 36 + par + ph - gross);
}

/** Inverse: the "adjusted gross" implied by a stableford total. */
function grossFromStableford(points, par, ph) {
  return par + ph + 36 - points;
}

/** Format an index the way WHS does: "NH" for none, plus-handicaps shown with +. */
function formatIndex(v) {
  if (v == null) return 'NH';
  return v < 0 ? '+' + Math.abs(v).toFixed(1) : v.toFixed(1);
}

module.exports = {
  WHS_TABLE, round1, scoreDifferential, indexFromDifferentials, applyCaps,
  courseHandicap, playingHandicap, netScore, stablefordFromGross, grossFromStableford, formatIndex,
};
