'use strict';
/**
 * The recompute engine. Everything derived (handicap history, playing handicaps, net/stableford,
 * positions, Order-of-Merit points, auto roll-of-honour rows) is rebuilt deterministically from the
 * entered data, so editing or deleting an old result safely re-flows later handicaps.
 */
const P = require('./points');
const { getSettings } = require('../db');
const standings = require('./standings');

/**
 * Society handicap context: per completed event, who (if anyone) gets a winner's cut and how big.
 * Monthly events: the winner (position entered as 1, or the outright top stableford) is cut
 * `monthlyWinCut` when the field has `monthlyMinField`+ players. Multi-round tournaments: the
 * tournament winner (best total) is cut the tournament's `winner_cut` on the final round, if it applies.
 * A tie with no position entered gives nobody the cut (count back needs hole-by-hole cards).
 */
function societyContext(db, cfg) {
  const ctx = new Map();
  const events = db.prepare("SELECT e.id, e.tournament_id, e.round_no, e.event_date FROM events e WHERE e.status='completed'").all();
  const rowsFor = db.prepare('SELECT user_id, stableford_in, position_in FROM results WHERE event_id=?');
  const pickWinners = (rows, valueOf) => {
    const p1 = rows.filter((r) => r.position_in === 1).map((r) => r.user_id);
    if (p1.length === 1) return new Set(p1);
    const vals = rows.map((r) => ({ u: r.user_id, v: valueOf(r) })).filter((x) => x.v != null && x.v > 0);
    if (!vals.length) return new Set();
    const max = Math.max(...vals.map((x) => x.v));
    const top = vals.filter((x) => x.v === max);
    return top.length === 1 ? new Set([top[0].u]) : new Set();
  };
  const tours = new Map();
  for (const e of events) {
    if (e.tournament_id) { if (!tours.has(e.tournament_id)) tours.set(e.tournament_id, []); tours.get(e.tournament_id).push(e); continue; }
    const rows = rowsFor.all(e.id);
    const field = rows.length;
    ctx.set(e.id, { field, winners: field >= cfg.monthlyMinField ? pickWinners(rows, (r) => r.stableford_in) : new Set(), winnerCut: cfg.monthlyWinCut });
  }
  for (const [tid, evs] of tours) {
    const t = db.prepare('SELECT * FROM tournaments WHERE id=?').get(tid);
    evs.sort((a, b) => (a.round_no || 0) - (b.round_no || 0) || a.event_date.localeCompare(b.event_date));
    const last = evs[evs.length - 1];
    const totals = new Map();
    for (const e of evs) for (const r of rowsFor.all(e.id)) totals.set(r.user_id, (totals.get(r.user_id) || 0) + (r.stableford_in || 0));
    const lastRows = rowsFor.all(last.id).map((r) => ({ ...r, total: totals.get(r.user_id) }));
    const winners = t && t.cut_applies && t.winner_cut ? pickWinners(lastRows, (r) => r.total) : new Set();
    for (const e of evs) ctx.set(e.id, { field: totals.size, winners: e.id === last.id ? winners : new Set(), winnerCut: t ? t.winner_cut : 0, tournament: t && t.name });
  }
  return ctx;
}

function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function recomputeUser(db, userId, S, ctx) {
  const mod = require('../rules').handicap(S.handicap_mode);
  if (ctx === undefined || (ctx === null && mod.id === 'society')) ctx = mod.context(db, S);
  const allowDefault = parseInt(S.default_allowance, 10) || 95;
  const maxIndex = parseFloat(S.max_index) || 54;
  const startIdx = parseFloat(S.default_start_index) || 28;
  const items = [];
  for (const a of db.prepare('SELECT * FROM handicap_adjustments WHERE user_id=?').all(userId)) {
    // starting handicaps always sort first; adjustments frozen from an earlier automatic cut sort after that day's result (as they were made)
    items.push({ t: 'adj', date: a.kind === 'initial' ? '0000-00-00' : a.effective_on, ord: a.note && a.note.startsWith('[kept from auto-adjust] ') ? 2 : 0, id: a.id, a });
  }
  const results = db.prepare(`
    SELECT r.*, e.event_date, e.title, e.status AS ev_status, e.counts_handicap, e.allowance_pct,
           c.par, c.rating, c.slope
    FROM results r JOIN events e ON e.id=r.event_id LEFT JOIN courses c ON c.id=e.course_id
    WHERE r.user_id=? AND e.status!='cancelled'`).all(userId);
  for (const r of results) items.push({ t: 'res', date: r.event_date, ord: 1, id: r.id, r });
  for (const x of db.prepare('SELECT * FROM extra_rounds WHERE user_id=?').all(userId)) {
    items.push({ t: 'extra', date: x.played_on, ord: 1, id: 1e9 + x.id, x });
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.ord - b.ord || a.id - b.id);

  // state shared with the handicap module
  const st = { current: null, hist: [], diffs: [], S, ctx, userId, startIdx, maxIndex, allowDefault, cfg: mod.options(S) };
  const updRes = db.prepare(`UPDATE results SET idx_at_event=?, course_handicap=?, playing_handicap=?, ags=?, stableford=?, net=?, differential=? WHERE id=?`);

  for (const it of items) {
    if (it.t === 'adj') {
      const before = st.current;
      st.current = Math.min(maxIndex, it.a.index_value);
      st.hist.push({ effective_on: it.a.effective_on, index_before: before, index_after: st.current, source: it.a.kind, label: it.a.note || (it.a.kind === 'initial' ? 'Starting handicap' : 'Handicap set by admin') });
    } else if (it.t === 'extra') {
      if (mod.usesGeneralPlay && mod.onExtra) mod.onExtra(st, it.x, it.date); // general-play rounds only feed modules that use them
    } else {
      let o;
      if (it.r.hcp_played != null) {
        // historical result: report the handicap actually played off, and leave the running handicap untouched
        const keep = { current: st.current, h: st.hist.length, d: st.diffs.length };
        st.current = it.r.hcp_played;
        o = mod.onResult(st, { ...it.r, counts_handicap: 0 }, it.date);
        st.current = keep.current; st.hist.length = keep.h; st.diffs.length = keep.d;
      } else o = mod.onResult(st, it.r, it.date);
      updRes.run(o.idx, o.ch, o.ph, o.ags, o.stable, o.net, o.diff, it.r.id);
    }
  }
  const { hist, current } = st;
  db.prepare('DELETE FROM handicap_history WHERE user_id=?').run(userId);
  const ins = db.prepare(`INSERT INTO handicap_history(user_id,seq,effective_on,index_before,index_after,source,result_id,extra_id,differential,label) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  hist.forEach((h, i) => ins.run(userId, i + 1, h.effective_on, h.index_before, h.index_after, h.source, h.result_id || null, h.extra_id || null, h.differential ?? null, h.label || null));
  db.prepare('UPDATE users SET handicap_index=? WHERE id=?').run(current, userId);
}

function recomputeEventPoints(db, S) {
  const events = db.prepare(`SELECT e.*, s.scheme AS season_scheme FROM events e JOIN seasons s ON s.id=e.season_id WHERE e.status!='cancelled'`).all();
  const defScheme = P.parseScheme(S.oom_default_scheme);
  const upd = db.prepare('UPDATE results SET position=?, points=? WHERE id=?');
  for (const e of events) {
    const rows = db.prepare('SELECT * FROM results WHERE event_id=?').all(e.id);
    if (!rows.length) continue;
    const scheme = P.parseScheme(e.season_scheme, defScheme);
    let ranks = new Map();
    if (e.scoring_basis === 'stableford') ranks = P.rankValues(rows.map((r) => ({ key: r.id, value: r.stableford })), { lower: false });
    else if (e.scoring_basis === 'stroke_net') ranks = P.rankValues(rows.map((r) => ({ key: r.id, value: r.net })), { lower: true });
    else if (e.scoring_basis === 'stroke_gross') ranks = P.rankValues(rows.map((r) => ({ key: r.id, value: r.gross != null ? r.gross : r.ags })), { lower: true });
    for (const r of rows) {
      const pos = r.position_in != null ? r.position_in : (ranks.get(r.id) || null);
      const pts = scheme.mode === 'score' ? (r.stableford != null ? r.stableford : 0) + (r.bonus || 0) : P.pointsFor(pos, scheme, { multiplier: e.points_multiplier, bonus: r.bonus });
      upd.run(pos, pts, r.id);
    }
  }
}

const PAIR_FORMATS = new Set(['foursomes', 'fourball', 'scramble']);

function syncHonours(db) {
  db.prepare("DELETE FROM honours WHERE source='auto'").run();
  const ins = db.prepare(`INSERT INTO honours(category_id,year,user_id,partner_id,detail,event_id,season_id,source) VALUES (?,?,?,?,?,?,?,'auto')`);
  const events = db.prepare(`SELECT * FROM events WHERE status='completed' AND honour_category_id IS NOT NULL`).all();
  for (const e of events) {
    const winners = db.prepare(`SELECT r.*, u.name FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND r.position=1 ORDER BY u.name`).all(e.id);
    if (!winners.length) continue;
    const year = parseInt(e.event_date.slice(0, 4), 10);
    const detailFor = (w) => {
      if (e.scoring_basis === 'stableford') return `${w.stableford} pts`;
      if (e.scoring_basis === 'stroke_net') return `${w.net} net`;
      if (e.scoring_basis === 'stroke_gross') return `${w.gross ?? w.ags} gross`;
      return w.note || 'Winner';
    };
    if (PAIR_FORMATS.has(e.format) && winners.length >= 2) {
      const d = detailFor(winners[0]);
      ins.run(e.honour_category_id, year, winners[0].user_id, winners[1].user_id, /pairs/.test(d) ? d : d + ' (pairs)', e.id, e.season_id);
    } else {
      for (const w of winners) ins.run(e.honour_category_id, year, w.user_id, null, detailFor(w), e.id, e.season_id);
    }
  }
  // multi-round tournaments: winner = best total over all rounds, once every round is completed
  for (const t of db.prepare('SELECT * FROM tournaments WHERE honour_category_id IS NOT NULL').all()) {
    const lb = tournamentBoard(db, t.id);
    if (!lb.complete || !lb.rows.length) continue;
    const top = lb.rows.filter((r) => r.rank === 1);
    const year = parseInt(lb.rounds[lb.rounds.length - 1].event_date.slice(0, 4), 10);
    for (const w of top) ins.run(t.honour_category_id, year, w.user_id, null, `${w.total} pts over ${lb.rounds.length} rounds${top.length > 1 ? ' (tie)' : ''}`, null, t.season_id);
  }
  const oom = db.prepare("SELECT id FROM honour_categories WHERE kind='oom' ORDER BY sort,id LIMIT 1").get();
  if (oom) {
    for (const s of db.prepare("SELECT * FROM seasons WHERE status='closed'").all()) {
      const table = standings.orderOfMerit(db, s.id);
      if (table.length && table[0].total > 0) ins.run(oom.id, s.year, table[0].user_id, null, `${table[0].total} season pts`, null, s.id);
    }
  }
}

/** Leaderboard for a multi-round tournament (sum of stableford over the rounds; 0/blank = did not play). */
function tournamentBoard(db, tid) {
  const rounds = db.prepare('SELECT * FROM events WHERE tournament_id=? ORDER BY round_no, event_date, id').all(tid);
  const by = new Map();
  rounds.forEach((e, i) => {
    for (const r of db.prepare('SELECT r.user_id, r.stableford, u.name, u.nickname FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=?').all(e.id)) {
      if (!by.has(r.user_id)) by.set(r.user_id, { user_id: r.user_id, name: r.name, nickname: r.nickname, scores: rounds.map(() => null), total: 0 });
      const o = by.get(r.user_id); o.scores[i] = r.stableford; o.total += r.stableford || 0;
    }
  });
  const rows = [...by.values()].sort((a, b) => b.total - a.total || (b.scores[b.scores.length - 1] || 0) - (a.scores[a.scores.length - 1] || 0) || a.name.localeCompare(b.name));
  let rank = 0;
  rows.forEach((o, i) => { if (!i || rows[i - 1].total !== o.total) rank = i + 1; o.rank = rank; });
  return { rounds, rows, complete: rounds.length > 0 && rounds.every((e) => e.status === 'completed') };
}

/** Rebuild everything derived. Safe to call any time; runs in one transaction. */
function recomputeAll(db) {
  const S = getSettings(db);
  db.transaction(() => {
    const ctx = require('../rules').handicap(S.handicap_mode).context(db, S);
    for (const u of db.prepare('SELECT id FROM users').all()) recomputeUser(db, u.id, S, ctx);
    recomputeEventPoints(db, S);
    syncHonours(db);
  })();
}

module.exports = { recomputeAll, recomputeUser, societyContext, tournamentBoard, recomputeEventPoints, syncHonours, addDays };
