'use strict';
/** Generic competition engine: score an event from a config. Pure; callers load/save rows. */
const B = require('./blocks');
const { PRESETS, normalise } = require('./presets');

/**
 * entries: [{ key, index?, ph?, card?, stableford?, net?, gross?, position_in?, bonus?, birdies? }]
 * course: { par, rating, slope, holes? }. opts.multiplier scales position points.
 * Returns [{ key, ph, gross, net, stableford, parBogey, position, points }].
 */
function scoreEvent(entries, course, config, { multiplier = 1 } = {}) {
  const cfg = typeof config === 'string' ? JSON.parse(config) : config;
  const scored = entries.map((e) => {
    const ph = e.ph != null ? e.ph : (e.index != null && course ? B.playingHandicap(B.courseHandicap(e.index, course), cfg.allowance?.pct ?? 100) : 0);
    const s = e.card ? B.scoreCard(e.card, course, ph, { cap: cfg.allowance?.cap }) : { gross: e.gross ?? null, net: e.net ?? null, stableford: e.stableford ?? null, parBogey: e.parBogey ?? null, holes: null };
    return { ...e, ph, ...s };
  });
  const m = B.METRIC[cfg.format] || B.METRIC.stableford;
  const ranks = B.rank(scored.map((s) => ({ key: s.key, value: cfg.format === 'manual' ? null : s[m.key], holes: s.holes, position_in: s.position_in })), { lower: m.lower, tieBreak: cfg.ranking?.tieBreak, field: m.key === 'stableford' ? 'pts' : 'net' });
  const field = scored.filter((s) => ranks.get(s.key) != null).length;
  return scored.map((s) => {
    const position = ranks.get(s.key);
    return { key: s.key, ph: s.ph, gross: s.gross, net: s.net, stableford: s.stableford, parBogey: s.parBogey, position, points: B.pointsFor(s, position, cfg.points, { field, multiplier }) };
  });
}

/** Season league table. results: [{ user, event, points }]; league cfg: { events?: [ids], bestN? }. */
function leagueTable(results, cfg = {}) {
  const allow = cfg.events ? new Set(cfg.events) : null;
  const by = new Map();
  for (const r of results) { if (allow && !allow.has(r.event)) continue; if (!by.has(r.user)) by.set(r.user, []); by.get(r.user).push(r.points); }
  const rows = [...by].map(([user, pts]) => { const s = pts.slice().sort((a, b) => b - a); const used = cfg.bestN ? s.slice(0, cfg.bestN) : s; return { user, total: used.reduce((a, b) => a + b, 0), played: pts.length }; });
  return rows.sort((a, b) => b.total - a.total || b.played - a.played);
}

/** The Demo preset for an event, driven by the season's OoM scheme (as the live site does). */
function classicConfig(event, scheme) {
  return { ...PRESETS.demo, format: event.scoring_basis === 'manual' ? 'manual' : event.scoring_basis, allowance: { pct: event.allowance_pct }, points: { mode: scheme.mode, positions: scheme.positions, participation: scheme.participation, bonuses: [] } };
}

module.exports = { ...B, scoreEvent, leagueTable, classicConfig, PRESETS, normalise };
