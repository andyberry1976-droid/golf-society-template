'use strict';
/**
 * Stats awards: worked out from the recorded results every time the page loads, so they move as soon
 * as scores are entered. Per season and all-time. An award is left out (and listed in `skipped`)
 * when the season has no data for it, e.g. birdies before 2010, or no previous season to compare with.
 *
 * Rounds = every recorded stableford score (monthly events, split rounds, majors and Euro rounds).
 * Wins, winning margins and attendance only count society events (tournament rounds are left out).
 */
const r1 = (n) => Math.round(n * 10) / 10;
const minRounds = (eventCount) => Math.max(3, Math.ceil(eventCount * 0.4));
/** "2026 Valley View Euro — Round 2", "August Stableford 2026" */
const evLabel = (r, withYear) => { const t = r.title.replace(/ \([^)]*\)$/, ''); return withYear && !/\b(19|20)\d\d\b/.test(t) ? `${t.replace(/ — .*$/, '')} ${r.event_date.slice(0, 4)}` : t.replace(/^(.*?Stableford) — .*$/, '$1'); };

function load(db) {
  const users = new Map(db.prepare('SELECT id, name, status FROM users').all().map((u) => [u.id, u]));
  const seasons = db.prepare('SELECT id, name, year, status FROM seasons ORDER BY year').all();
  const rounds = db.prepare(`SELECT r.user_id, r.stableford, r.position, e.id event_id, e.title, e.event_date, e.season_id, e.tournament_id
    FROM results r JOIN events e ON e.id=r.event_id WHERE e.status='completed' AND r.stableford IS NOT NULL ORDER BY e.event_date, e.id`).all();
  const birdies = db.prepare(`SELECT c.user_id, e.season_id, SUM(c.value) n FROM comp_scores c JOIN events e ON e.id=c.event_id
    WHERE c.comp='birdie' AND e.status='completed' GROUP BY c.user_id, e.season_id`).all();
  return { users, seasons, rounds, birdies };
}

/** holder object for reccard: several tied players are listed together. */
function holderOf(D, ids) {
  const us = [...new Set(ids)].map((i) => D.users.get(i)).filter(Boolean);
  const one = us.length === 1 && us[0].status === 'active' ? us[0].id : null;
  return { id: one, name: us.map((u) => u.name).join(' & ') || '—' };
}
/** best by score fn (higher wins unless low=true); returns all ties. */
function top(items, score, low = false) {
  let best = null; let out = [];
  for (const it of items) { const s = score(it); if (s == null) continue; if (best == null || (low ? s < best : s > best)) { best = s; out = [it]; } else if (s === best) out.push(it); }
  return { best, items: out };
}

function seasonFacts(D, sid) {
  const rs = D.rounds.filter((r) => r.season_id === sid);
  const events = [...new Map(rs.filter((r) => r.tournament_id == null).map((r) => [r.event_id, r])).values()];
  const per = new Map();
  for (const r of rs) { const p = per.get(r.user_id) || { id: r.user_id, n: 0, sum: 0, wins: 0 }; p.n++; p.sum += r.stableford; if (r.tournament_id == null && r.position === 1) p.wins++; per.set(r.user_id, p); }
  return { rs, events, per, min: minRounds(events.length) };
}

function avgOf(f) { return [...f.per.values()].filter((p) => p.n >= f.min).map((p) => ({ ...p, avg: p.sum / p.n })); }

function margins(f) {
  const out = [];
  for (const e of f.events) {
    const field = f.rs.filter((r) => r.event_id === e.event_id).sort((a, b) => b.stableford - a.stableford);
    if (field.length >= 2) out.push({ id: field[0].user_id, m: field[0].stableford - field[1].stableford, e });
  }
  return out;
}

function streaksOf(f) {
  const played = new Set(f.rs.filter((r) => r.tournament_id == null).map((r) => r.event_id + ':' + r.user_id));
  const out = [];
  for (const id of f.per.keys()) { let cur = 0; let best = 0; for (const e of f.events) { if (played.has(e.event_id + ':' + id)) { cur++; best = Math.max(best, cur); } else cur = 0; } out.push({ id, n: best }); }
  return out;
}

function spoon(db, D, sid, f) {
  const rows = require('./standings').orderOfMerit(db, sid).filter ? require('./standings').orderOfMerit(db, sid) : [];
  const ok = rows.filter((r) => (r.played || 0) >= f.min);
  if (!ok.length) return null;
  const worst = Math.min(...ok.map((r) => r.total));
  return { best: worst, ids: ok.filter((r) => r.total === worst).map((r) => r.user_id) };
}

const DEF = {
  best: { label: 'Best single score', icon: 's-star', tint: '#fff3b8' },
  worst: { label: 'Worst single score', icon: 's-lost', tint: '#e6defa' },
  birdies: { label: 'Most birdies', icon: 's-spark', tint: '#d9fbe9' },
  rounds: { label: 'Most rounds played', icon: 's-tee', tint: '#ffe9c7' },
  wins: { label: 'Most wins', icon: 's-trophy', tint: '#fff3b8' },
  avg: { label: 'Best season average', icon: 's-up', tint: '#d9fbe9' },
  improved: { label: 'Most improved', icon: 's-bow', tint: '#fde1f2' },
  margin: { label: 'Biggest winning margin', icon: 's-drive', tint: '#ffe9c7' },
  streak: { label: 'Longest attendance streak', icon: 's-flag', tint: '#e6defa' },
  spoon: { label: 'Wooden spoon', icon: 's-spoon', tint: '#fde1f2' },
};
const card = (D, key, value, ids, meta, date) => ({ key, ...DEF[key], value, holder: holderOf(D, ids), meta: meta || '', date: date || null });
const pts = (n) => `${n} pts`;

/** Stats awards for one season: { cards, skipped:[{label, why}] } */
function forSeason(db, sid, D = load(db)) {
  const f = seasonFacts(D, sid); const cards = []; const skipped = [];
  const skip = (k, why) => skipped.push({ label: DEF[k].label, why });
  if (!f.rs.length) { for (const k of Object.keys(DEF)) skip(k, 'no scores recorded this season'); return { cards, skipped, min: f.min }; }
  const evName = (r) => evLabel(r, false);
  let t = top(f.rs, (r) => r.stableford); cards.push(card(D, 'best', pts(t.best), t.items.map((r) => r.user_id), t.items.length === 1 ? evName(t.items[0]) : `${t.items.length} times`, t.items.length === 1 ? t.items[0].event_date : null));
  t = top(f.rs, (r) => r.stableford, true); cards.push(card(D, 'worst', pts(t.best), t.items.map((r) => r.user_id), t.items.length === 1 ? evName(t.items[0]) : `${t.items.length} times`, t.items.length === 1 ? t.items[0].event_date : null));
  const b = D.birdies.filter((x) => x.season_id === sid && x.n > 0);
  if (b.length) { t = top(b, (x) => x.n); cards.push(card(D, 'birdies', `${t.best} birdies`, t.items.map((x) => x.user_id), 'Birdie League')); } else skip('birdies', 'no birdie counts recorded');
  const per = [...f.per.values()];
  t = top(per, (p) => p.n); cards.push(card(D, 'rounds', `${t.best} rounds`, t.items.map((p) => p.id)));
  t = top(per, (p) => p.wins || null); if (t.best) cards.push(card(D, 'wins', `${t.best} win${t.best > 1 ? 's' : ''}`, t.items.map((p) => p.id))); else skip('wins', 'no event winners recorded');
  const av = avgOf(f);
  if (av.length) { t = top(av, (p) => r1(p.avg)); cards.push(card(D, 'avg', pts(t.best.toFixed(1)), t.items.map((p) => p.id), `min ${f.min} rounds`)); } else skip('avg', `nobody played ${f.min}+ rounds`);
  // most improved: season average up on the previous recorded season (both with enough rounds)
  const yr = D.seasons.find((s) => s.id === sid).year;
  const prev = D.seasons.find((s) => s.year === yr - 1);
  const pf = prev ? seasonFacts(D, prev.id) : null;
  if (pf && pf.rs.length && av.length) {
    const pav = new Map(avgOf(pf).map((p) => [p.id, p.avg]));
    const imp = av.filter((p) => pav.has(p.id)).map((p) => ({ id: p.id, d: r1(p.avg - pav.get(p.id)), from: pav.get(p.id), to: p.avg }));
    t = top(imp, (p) => p.d);
    if (t.items.length && t.best > 0) cards.push(card(D, 'improved', `+${t.best.toFixed(1)} pts`, t.items.map((p) => p.id), t.items.length === 1 ? `average ${r1(t.items[0].from).toFixed(1)} → ${r1(t.items[0].to).toFixed(1)}` : `average up on ${prev.name}`));
    else skip('improved', 'nobody improved on their previous-season average');
  } else skip('improved', prev ? `no qualifying ${prev.name} scores to compare with` : `no ${yr - 1} season recorded`);
  const m = margins(f);
  if (m.length) { t = top(m, (x) => x.m || null); if (t.best) cards.push(card(D, 'margin', `${t.best} pts`, t.items.map((x) => x.id), t.items.length === 1 ? evName(t.items[0].e) : `${t.items.length} times`, t.items.length === 1 ? t.items[0].e.event_date : null)); else skip('margin', 'every win was a tie'); } else skip('margin', 'no events with two or more scores');
  if (f.events.length) { t = top(streaksOf(f), (x) => x.n); cards.push(card(D, 'streak', `${t.best} in a row`, t.items.map((x) => x.id), `of ${f.events.length} events`)); } else skip('streak', 'no society events');
  const sp = spoon(db, D, sid, f);
  const open = D.seasons.find((s) => s.id === sid).status !== 'closed';
  if (sp) cards.push(card(D, 'spoon', pts(sp.best), sp.ids, `${open ? 'currently ' : ''}bottom of the Order of Merit (min ${f.min} rounds)`)); else skip('spoon', 'no Order of Merit table');
  return { cards, skipped, min: f.min };
}

/** All-time: records across every season. */
function allTime(db, D = load(db)) {
  const cards = []; const skipped = [];
  const withData = D.seasons.filter((s) => D.rounds.some((r) => r.season_id === s.id));
  if (!D.rounds.length) return { cards, skipped, seasons: [] };
  const evName = (r) => evLabel(r, true);
  let t = top(D.rounds, (r) => r.stableford); cards.push(card(D, 'best', pts(t.best), t.items.map((r) => r.user_id), t.items.length === 1 ? evName(t.items[0]) : `${t.items.length} times`, t.items.length === 1 ? t.items[0].event_date : null));
  t = top(D.rounds, (r) => r.stableford, true); cards.push(card(D, 'worst', pts(t.best), t.items.map((r) => r.user_id), t.items.length === 1 ? evName(t.items[0]) : `${t.items.length} times`, t.items.length === 1 ? t.items[0].event_date : null));
  const bt = new Map(); for (const x of D.birdies) bt.set(x.user_id, (bt.get(x.user_id) || 0) + x.n);
  t = top([...bt].map(([id, n]) => ({ id, n })), (x) => x.n || null); if (t.best) cards.push(card(D, 'birdies', `${t.best} birdies`, t.items.map((x) => x.id), 'career total'));
  const bs = top(D.birdies, (x) => x.n || null); const bsy = bs.best ? D.seasons.find((s) => s.id === bs.items[0].season_id) : null;
  if (bsy) cards.push({ ...card(D, 'birdies', `${bs.best} birdies`, bs.items.map((x) => x.user_id), bs.items.length === 1 ? `in ${bsy.name}` : 'in one season'), key: 'birdies-season', label: 'Most birdies in a season' });
  const career = new Map(); for (const r of D.rounds) { const c = career.get(r.user_id) || { id: r.user_id, n: 0, wins: 0 }; c.n++; if (r.tournament_id == null && r.position === 1) c.wins++; career.set(r.user_id, c); }
  t = top([...career.values()], (c) => c.n); cards.push(card(D, 'rounds', `${t.best} rounds`, t.items.map((c) => c.id), 'career total'));
  t = top([...career.values()], (c) => c.wins || null); if (t.best) cards.push(card(D, 'wins', `${t.best} wins`, t.items.map((c) => c.id), 'career total'));
  const seasonal = withData.map((s) => ({ s, f: seasonFacts(D, s.id) }));
  const avs = seasonal.flatMap(({ s, f }) => avgOf(f).map((p) => ({ ...p, s })));
  t = top(avs, (p) => r1(p.avg)); if (t.best != null) cards.push(card(D, 'avg', pts(t.best.toFixed(1)), t.items.map((p) => p.id), t.items.map((p) => p.s.name).join(', ')));
  const imps = withData.map((s) => forSeason(db, s.id, D).cards.filter((c) => c.key === 'improved').map((c) => ({ c, s, d: parseFloat(c.value) }))).flat();
  if (imps.length) { t = top(imps, (x) => x.d); cards.push({ ...t.items[0].c, meta: `${t.items[0].s.name}: ${t.items[0].c.meta}` }); } else skipped.push({ label: DEF.improved.label, why: 'needs two consecutive seasons' });
  const ms = seasonal.flatMap(({ f }) => margins(f)); t = top(ms, (x) => x.m || null);
  if (t.best) cards.push(card(D, 'margin', `${t.best} pts`, t.items.map((x) => x.id), t.items.length === 1 ? evName(t.items[0].e) : `${t.items.length} times`, t.items.length === 1 ? t.items[0].e.event_date : null));
  const st = seasonal.flatMap(({ s, f }) => streaksOf(f).map((x) => ({ ...x, s }))); t = top(st, (x) => x.n || null);
  if (t.best) cards.push(card(D, 'streak', `${t.best} in a row`, t.items.map((x) => x.id), `within one season (${[...new Set(t.items.map((x) => x.s.name))].join(', ')})`));
  const spoons = new Map(); for (const { s, f } of seasonal) { const sp = spoon(db, D, s.id, f); if (sp && s.status === 'closed') for (const id of sp.ids) spoons.set(id, (spoons.get(id) || 0) + 1); }
  if (spoons.size) { t = top([...spoons].map(([id, n]) => ({ id, n })), (x) => x.n); cards.push({ ...card(D, 'spoon', `${t.best} spoon${t.best > 1 ? 's' : ''}`, t.items.map((x) => x.id), 'most wooden spoons (finished seasons)'), label: 'Most wooden spoons' }); }
  return { cards, skipped, seasons: withData.map((s) => s.name) };
}

module.exports = { forSeason, allTime, load, minRounds };
