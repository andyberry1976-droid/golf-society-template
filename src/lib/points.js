'use strict';
/** Order of Merit points scheme helpers (pure). */

const DEFAULT_SCHEME = { positions: [30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1], participation: 5, bestN: null };

function parseScheme(raw, fallback = DEFAULT_SCHEME) {
  let s = raw;
  if (typeof raw === 'string') { try { s = JSON.parse(raw); } catch { s = null; } }
  if (!s || (!Array.isArray(s.positions) && s.mode !== 'score')) s = fallback;
  return {
    mode: s.mode === 'score' ? 'score' : 'points',
    countback: !!s.countback,
    positions: (s.positions || DEFAULT_SCHEME.positions).map((n) => Math.max(0, parseInt(n, 10) || 0)),
    participation: Math.max(0, parseInt(s.participation, 10) || 0),
    bestN: s.bestN ? Math.max(1, parseInt(s.bestN, 10)) : null,
  };
}

/** Human description of a scheme (used on the standings page). */
function describe(s) {
  if (s.mode === 'score') return `Stableford scores${s.bestN ? `: best ${s.bestN} count` : ', all count'}${s.countback ? `. Ties: ${s.bestN ? `${s.bestN + 1}th score, then the next, ` : ''}then most appearances` : ''}.`;
  return `Position points: 1st ${s.positions[0] || 0}, 2nd ${s.positions[1] || 0}, 3rd ${s.positions[2] || 0}… plus ${s.participation} for playing${s.bestN ? `. Best ${s.bestN} scores count` : '. All rounds count'}.`;
}

/** Order two OoM rows by total, then (countback) the dropped scores in order, then appearances. */
function compareCountback(a, b) {
  if (b.total !== a.total) return b.total - a.total;
  const ra = a.rest || []; const rb = b.rest || [];
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const d = (rb[i] ?? -1) - (ra[i] ?? -1);
    if (d) return d;
  }
  return b.played - a.played;
}

/** Points for a single result: position points scaled by the event multiplier, + participation + bonus. */
function pointsFor(position, scheme, { multiplier = 1, bonus = 0 } = {}) {
  const posPts = position && position > 0 ? (scheme.positions[position - 1] || 0) : 0;
  return Math.round(posPts * multiplier) + scheme.participation + (bonus || 0);
}

/** Competition ranking (1,2,2,4) of an array of {key, value}; lower=true means lower value is better. */
function rankValues(items, { lower }) {
  const sorted = items.filter((i) => i.value != null).sort((a, b) => (lower ? a.value - b.value : b.value - a.value));
  const out = new Map();
  let rank = 0; let prev;
  sorted.forEach((it, idx) => {
    if (idx === 0 || it.value !== prev) rank = idx + 1;
    prev = it.value;
    out.set(it.key, rank);
  });
  return out;
}

/** Sum of the best N entries (or all when bestN is null). */
function bestN(pointsList, n) {
  const sorted = pointsList.slice().sort((a, b) => b - a);
  const used = n ? sorted.slice(0, n) : sorted;
  return { total: used.reduce((s, p) => s + p, 0), counted: used.length, dropped: sorted.length - used.length, rest: n ? sorted.slice(n) : [] };
}

module.exports = { DEFAULT_SCHEME, parseScheme, describe, compareCountback, pointsFor, rankValues, bestN };
