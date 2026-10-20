'use strict';
/**
 * Society-specific pure helpers (no DB): the "society" handicap adjustment, achievement codes,
 * FedEx points, Birdie League and knockout-bracket maths.
 */
const { round1 } = require('./handicap');

const DEFAULT_SOCIETY_HCP = {
  bufferLow: 33, bufferHigh: 36,
  // category upper bounds (on the whole-number part of the index) and the cut per point over bufferHigh
  categories: [{ cat: 1, max: 5, cut: 0.1 }, { cat: 2, max: 12, cut: 0.2 }, { cat: 3, max: 21, cut: 0.3 }, { cat: 4, max: 99, cut: 0.4 }],
  underAdd: 0.2, // added for scores under bufferLow
  fortyPlus: 40, fortyPlusCut: 1, // "any player scoring 40+ points will be cut a further shot"
  monthlyWinCut: 1, monthlyMinField: 9, // winners cut 1 shot in a monthly medal with 9+ players
};

function parseSocietyHcp(raw) {
  let s = raw;
  if (typeof raw === 'string') { try { s = JSON.parse(raw); } catch { s = null; } }
  return { ...DEFAULT_SOCIETY_HCP, ...(s || {}), categories: (s && Array.isArray(s.categories) && s.categories.length) ? s.categories : DEFAULT_SOCIETY_HCP.categories };
}

function category(index, cfg = DEFAULT_SOCIETY_HCP) {
  if (index == null) return null;
  const whole = Math.floor(index + 1e-9);
  for (const c of cfg.categories) if (whole <= c.max) return c.cat;
  return cfg.categories[cfg.categories.length - 1].cat;
}

/** Society playing handicap: the index rounded to a whole number (matches the spreadsheet). */
function playingFromIndex(index) {
  return index == null ? null : Math.round(index + 1e-9);
}

/**
 * Change to a player's index after one stableford round.
 * opts.winnerCut: shots to cut because they won (already decided by the caller).
 * Returns { delta, parts: [labels] }.
 */
function societyAdjustment(index, points, { winnerCut = 0, cfg = DEFAULT_SOCIETY_HCP } = {}) {
  const parts = [];
  let d = 0;
  const cat = category(index, cfg);
  const rule = cfg.categories.find((c) => c.cat === cat) || cfg.categories[cfg.categories.length - 1];
  if (points > cfg.bufferHigh) { const x = -(points - cfg.bufferHigh) * rule.cut; d += x; parts.push(`${points - cfg.bufferHigh} over buffer × ${rule.cut}`); }
  else if (points < cfg.bufferLow) { d += cfg.underAdd; parts.push(`under ${cfg.bufferLow} +${cfg.underAdd}`); }
  if (cfg.fortyPlus && points >= cfg.fortyPlus) { d -= cfg.fortyPlusCut; parts.push(`${cfg.fortyPlus}+ pts −${cfg.fortyPlusCut}`); }
  if (winnerCut) { d -= winnerCut; parts.push(`winner −${winnerCut}`); }
  return { delta: round1(d), parts };
}

function applySociety(index, points, opts) {
  const { delta, parts } = societyAdjustment(index, points, opts);
  return { index: round1(index + delta), delta, parts };
}

// ---- Achievements --------------------------------------------------------------
const TITLE_KEYS = {
  '*': { key: 'major', label: 'Major', plural: 'Majors', icon: '🏆' },
  '£': { key: 'oom', label: 'Order of Merit', plural: 'Order of Merit titles', icon: '💷' },
  '€': { key: 'euro', label: 'European Open', plural: 'European Opens', icon: '🇪🇺' },
  M: { key: 'matchplay', label: 'Matchplay', plural: 'Matchplay titles', icon: '⚔️' },
  F: { key: 'fedex', label: 'FedEx Cup', plural: 'FedEx Cups', icon: '📦' },
};

/** "HIOC2, ***, £££, €, FFFFF" -> { hioc:2, major:3, oom:3, euro:1, matchplay:0, fedex:5, unknown:[] } */
function parseAchievements(code) {
  const out = { hioc: 0, major: 0, oom: 0, euro: 0, matchplay: 0, fedex: 0, unknown: [] };
  if (!code) return out;
  for (const raw of String(code).split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const h = t.match(/^HIOC\s*(\d+)?$/i);
    if (h) { out.hioc += h[1] ? parseInt(h[1], 10) : 1; continue; }
    const m = t.match(/^(\d+)?\s*([*£€MF])\2*$/);
    if (m) { out[TITLE_KEYS[m[2]].key] += m[1] ? parseInt(m[1], 10) : t.replace(/\d/g, '').trim().length; continue; }
    out.unknown.push(t);
  }
  return out;
}
function titleCount(a) { return a.major + a.oom + a.euro + a.matchplay + a.fedex; }
function badges(a) {
  const b = [];
  if (a.hioc) b.push({ key: 'hioc', label: a.hioc > 1 ? `Hole-in-one club ×${a.hioc}` : 'Hole-in-one club', icon: '⛳', n: a.hioc });
  for (const sym of ['*', '£', '€', 'M', 'F']) {
    const t = TITLE_KEYS[sym]; const n = a[t.key];
    if (n) b.push({ key: t.key, label: n > 1 ? `${t.label} ×${n}` : `${t.label} winner`, icon: t.icon, n });
  }
  return b;
}

// ---- FedEx & Birdie League ----------------------------------------------------------
/** Top-10 places score 10..1 (ties share the place's points). */
function fedexPoints(position) {
  return position && position >= 1 && position <= 10 ? 11 - position : 0;
}
/** Birdie League value for a round: birdies + 2 per eagle. */
function birdieValue(birdies = 0, eagles = 0) { return (birdies || 0) + 2 * (eagles || 0); }

/** Generic season table: [{user_id,name,values:[n...]}] -> sorted with totals & competition ranks. */
function tableFrom(rows) {
  const out = rows.map((r) => ({ ...r, total: r.values.reduce((s, v) => s + (v || 0), 0), played: r.values.filter((v) => v != null).length }));
  out.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  let rank = 0;
  out.forEach((o, i) => { if (!i || out[i - 1].total !== o.total) rank = i + 1; o.rank = rank; });
  return out;
}

// ---- Knockout bracket ------------------------------------------------------------
function roundNames(nRounds) {
  const names = [];
  for (let r = 1; r <= nRounds; r++) {
    const left = nRounds - r; // 0 = final
    names.push(left === 0 ? 'Final' : left === 1 ? 'Semi-finals' : left === 2 ? 'Quarter-finals' : `Round ${r}`);
  }
  return names;
}
/** Where the winner of (round, slot) goes next: { round, slot, side: 1|2 }. */
function nextSlot(round, slot) { return { round: round + 1, slot: Math.ceil(slot / 2), side: slot % 2 ? 1 : 2 }; }
function matchesInRound(size, round) { return size / 2 ** round; }
const isBye = (name) => /^bye$/i.test(String(name || '').trim());

module.exports = {
  DEFAULT_SOCIETY_HCP, parseSocietyHcp, category, playingFromIndex, societyAdjustment, applySociety,
  TITLE_KEYS, parseAchievements, titleCount, badges, fedexPoints, birdieValue, tableFrom,
  roundNames, nextSlot, matchesInRound, isBye,
};
