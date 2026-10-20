'use strict';
/** Editable starting configs for the "New competition" form. Stored as JSON in competition_types.config. */
const POS = [30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1];
const PRESETS = {
  demo: { label: 'Demo (current site rules)', format: 'stableford', team: null, allowance: { pct: 95 }, ranking: { tieBreak: 'none' }, points: { mode: 'points', positions: POS, participation: 5, bonuses: [] } },
  stableford: { label: 'Stableford singles', format: 'stableford', team: null, allowance: { pct: 95 }, ranking: { tieBreak: 'countback' }, points: { mode: 'points', positions: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], participation: 0, bonuses: [] } },
  medal_net: { label: 'Medal (net strokeplay)', format: 'stroke_net', team: null, allowance: { pct: 95, cap: { type: 'net_double_bogey' } }, ranking: { tieBreak: 'countback' }, points: { mode: 'points', positions: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], participation: 0, bonuses: [] } },
  medal_gross: { label: 'Gross strokeplay', format: 'stroke_gross', team: null, allowance: { pct: 0 }, ranking: { tieBreak: 'countback' }, points: { mode: 'points', positions: [25, 18, 15, 12, 10, 8, 6, 4, 2, 1], participation: 0, bonuses: [] } },
  par_bogey: { label: 'Par / bogey', format: 'par_bogey', team: null, allowance: { pct: 90 }, ranking: { tieBreak: 'countback' }, points: { mode: 'points', positions: [10, 6, 4, 2, 1], participation: 0, bonuses: [] } },
  texas_scramble: { label: 'Texas scramble (4 ball)', format: 'stroke_net', team: { size: 4, type: 'scramble', weights: [0.25, 0.2, 0.15, 0.1] }, allowance: { pct: 100 }, ranking: { tieBreak: 'countback' }, points: { mode: 'points', positions: [10, 6, 4], participation: 0, bonuses: [] } },
  better_ball: { label: 'Better-ball stableford (pairs)', format: 'stableford', team: { size: 2, type: 'better_ball' }, allowance: { pct: 85 }, ranking: { tieBreak: 'countback' }, points: { mode: 'points', positions: [10, 6, 4], participation: 0, bonuses: [] } },
  matchplay: { label: 'Matchplay', format: 'matchplay', team: null, allowance: { pct: 100, difference: true }, ranking: { tieBreak: 'none' }, points: { mode: 'points', positions: [], participation: 0, bonuses: [] } },
};
const FORMATS = ['stableford', 'stroke_net', 'stroke_gross', 'par_bogey', 'matchplay'];
/** Normalise any user-supplied config into a safe shape. */
function normalise(c = {}) {
  const base = PRESETS[c.preset] || PRESETS.stableford;
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const p = c.points || {};
  return {
    preset: PRESETS[c.preset] ? c.preset : 'stableford',
    format: FORMATS.includes(c.format) ? c.format : base.format,
    team: c.team === undefined ? base.team : c.team,
    allowance: { pct: Math.min(100, Math.max(0, num(c.allowance?.pct, base.allowance.pct))), ...(c.allowance?.cap ? { cap: c.allowance.cap } : base.allowance.cap ? { cap: base.allowance.cap } : {}) },
    ranking: { tieBreak: (c.ranking?.tieBreak || base.ranking.tieBreak) === 'countback' ? 'countback' : 'none' },
    points: {
      mode: p.mode === 'score' ? 'score' : 'points',
      positions: (Array.isArray(p.positions) ? p.positions : base.points.positions).map((n) => Math.max(0, parseInt(n, 10) || 0)).slice(0, 50),
      participation: Math.max(0, parseInt(p.participation ?? base.points.participation, 10) || 0),
      bonuses: (Array.isArray(p.bonuses) ? p.bonuses : base.points.bonuses).filter((b) => b && /^(played|birdies|last|stableford>=\d+)$/.test(b.when)).map((b) => ({ when: b.when, pts: parseInt(b.pts, 10) || 0 })),
    },
  };
}
module.exports = { PRESETS, FORMATS, normalise };
