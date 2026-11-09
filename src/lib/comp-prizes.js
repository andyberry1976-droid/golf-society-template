'use strict';
/**
 * Season competition prize fund (Order of Merit, Matchplay, Birdie League, FedEx Cup).
 * Separate from event-level prize_lines /prize-money (which pays placings per event).
 * Stored as JSON in settings.comp_prize_fund, keyed by season year. No money is assigned to players here.
 */
const PZ = require('./prizes');

const COMPS = [
  { key: 'oom', label: 'Order of Merit', path: '/standings' },
  { key: 'matchplay', label: 'Match Play', path: '/matchplay' },
  { key: 'birdie', label: 'Birdie League', path: '/birdie-league' },
  { key: 'fedex', label: 'FedEx Cup', path: '/fedex' },
];

const emptyYear = () => ({
  paid_subs: null,
  kitty_pence: null,
  comps: Object.fromEntries(COMPS.map((c) => [c.key, { total_pence: null, places: [] }])),
});

function parseStore(raw) {
  if (!raw || !String(raw).trim()) return {};
  try {
    const j = JSON.parse(String(raw));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function loadAll(settings) {
  return parseStore(settings && settings.comp_prize_fund);
}

function normalizeYear(raw) {
  const out = emptyYear();
  if (!raw || typeof raw !== 'object') return out;
  const ps = Number(raw.paid_subs);
  out.paid_subs = Number.isInteger(ps) && ps >= 0 ? ps : null;
  const kp = Number(raw.kitty_pence);
  out.kitty_pence = Number.isInteger(kp) && kp >= 0 ? kp : null;
  const comps = raw.comps && typeof raw.comps === 'object' ? raw.comps : {};
  for (const c of COMPS) {
    const src = comps[c.key] || {};
    const tot = Number(src.total_pence);
    const places = Array.isArray(src.places) ? src.places : [];
    out.comps[c.key] = {
      total_pence: Number.isInteger(tot) && tot > 0 ? tot : null,
      places: places.map((p) => ({
        place: Number(p.place) || 0,
        label: String(p.label || '').trim() || placeLabel(Number(p.place) || 0),
        amount_pence: Number(p.amount_pence) || 0,
      })).filter((p) => p.amount_pence > 0).sort((a, b) => a.place - b.place),
    };
  }
  return out;
}

function placeLabel(n) {
  if (n === 1) return 'Winner';
  if (n === 2) return 'Runner-up';
  if (n === 3) return 'Third';
  if (n === 4) return 'Fourth';
  return n ? `${n}th` : 'Place';
}

/** Fund for one season year, or null if nothing configured. */
function forYear(settings, year) {
  const y = Number(year);
  if (!Number.isInteger(y)) return null;
  const all = loadAll(settings);
  if (!all[String(y)]) return null;
  const fund = normalizeYear(all[String(y)]);
  const hasComp = COMPS.some((c) => fund.comps[c.key].places.length || fund.comps[c.key].total_pence);
  if (!hasComp && fund.kitty_pence == null && fund.paid_subs == null) return null;
  return { year: y, ...fund };
}

/** One competition's prize box for a public page; null if that comp has no places. */
function forComp(settings, year, compKey) {
  const fund = forYear(settings, year);
  if (!fund) return null;
  const comp = fund.comps[compKey];
  if (!comp || !comp.places.length) return null;
  const meta = COMPS.find((c) => c.key === compKey) || { key: compKey, label: compKey };
  return {
    year: fund.year,
    key: meta.key,
    label: meta.label,
    total_pence: comp.total_pence || comp.places.reduce((s, p) => s + p.amount_pence, 0),
    places: comp.places,
    kitty_pence: fund.kitty_pence,
    paid_subs: fund.paid_subs,
  };
}

/** Persist one year's fund (merges into the store). Pass null/empty to clear that year. */
function saveYear(db, setSetting, settings, year, yearData) {
  const y = String(Number(year));
  const all = loadAll(settings);
  if (!yearData) {
    delete all[y];
  } else {
    all[y] = normalizeYear(yearData);
  }
  setSetting(db, 'comp_prize_fund', JSON.stringify(all));
  return all;
}

/** Build year data from an admin form body (pence via PZ.parseAmount; blank clears). */
function fromForm(body, cur = '£') {
  const paid = String(body.paid_subs || '').trim();
  const paid_subs = paid === '' ? null : (/^\d{1,4}$/.test(paid) ? Number(paid) : NaN);
  const kittyRaw = String(body.kitty || '').trim();
  const kitty_pence = kittyRaw === '' ? null : PZ.parseAmount(kittyRaw, cur);
  if (paid !== '' && !Number.isInteger(paid_subs)) return { ok: false, errors: { paid_subs: 'Paid subs must be a whole number (or blank).' } };
  if (kittyRaw && kitty_pence == null) return { ok: false, errors: { kitty: 'Kitty must be a positive amount (or blank).' } };

  const comps = {};
  for (const c of COMPS) {
    const places = [];
    for (const [place, field, fallbackLabel] of [[1, 'w1', 'Winner'], [2, 'w2', 'Runner-up'], [3, 'w3', 'Third']]) {
      const raw = String(body[`${c.key}_${field}`] || '').trim();
      if (!raw) continue;
      const amount_pence = PZ.parseAmount(raw, cur);
      if (amount_pence == null) return { ok: false, errors: { [`${c.key}_${field}`]: `${c.label} ${fallbackLabel}: enter a positive amount.` } };
      places.push({ place, label: fallbackLabel, amount_pence });
    }
    const total = places.reduce((s, p) => s + p.amount_pence, 0);
    comps[c.key] = { total_pence: total || null, places };
  }
  return { ok: true, data: { paid_subs, kitty_pence, comps } };
}

/** Sample 2026 defaults from sample prize-fund sheet (used for seed / first install). */
const DEFAULT_2026 = {
  paid_subs: 33,
  kitty_pence: 66000,
  comps: {
    oom: { total_pence: 26000, places: [
      { place: 1, label: 'Winner', amount_pence: 15000 },
      { place: 2, label: 'Runner-up', amount_pence: 7000 },
      { place: 3, label: 'Third', amount_pence: 4000 },
    ] },
    matchplay: { total_pence: 20000, places: [
      { place: 1, label: 'Winner', amount_pence: 12000 },
      { place: 2, label: 'Runner-up', amount_pence: 8000 },
    ] },
    birdie: { total_pence: 10000, places: [
      { place: 1, label: 'Winner', amount_pence: 5000 },
      { place: 2, label: 'Runner-up', amount_pence: 3000 },
      { place: 3, label: 'Third', amount_pence: 2000 },
    ] },
    fedex: { total_pence: 10000, places: [
      { place: 1, label: 'Winner', amount_pence: 5000 },
      { place: 2, label: 'Runner-up', amount_pence: 3000 },
      { place: 3, label: 'Third', amount_pence: 2000 },
    ] },
  },
};

module.exports = {
  COMPS, emptyYear, loadAll, normalizeYear, forYear, forComp, saveYear, fromForm, DEFAULT_2026, placeLabel,
  fmtMoney: PZ.fmtMoney,
};
