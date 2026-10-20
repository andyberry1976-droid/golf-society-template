'use strict';
/** Queries for the side competitions: Birdie League, FedEx Cup, matchplay brackets, tournaments, hall of fame. */
const Soc = require('./society');

/** Season events that can carry Birdie/FedEx scores (completed or scheduled, oldest first). */
function seasonEvents(db, seasonId) {
  return db.prepare(`SELECT e.id, e.title, e.event_date, e.status, e.tournament_id, e.round_no, e.counts_birdie, e.counts_fedex, c.name AS venue FROM events e LEFT JOIN courses c ON c.id=e.course_id
    WHERE e.season_id=? AND e.status!='cancelled' ORDER BY e.event_date, e.id`).all(seasonId);
}

/** Holder of a trophy going into `year` (most recent honour in that category before it). */
// the holder is last year's winner (not an older one when a year is missing from the records)
function holder(db, catName, year) {
  return db.prepare(`SELECT u.id, u.name, h.year FROM honours h JOIN honour_categories c ON c.id=h.category_id JOIN users u ON u.id=h.user_id
    WHERE c.name=? AND h.year=? ORDER BY h.id DESC LIMIT 1`).get(catName, year - 1) || null;
}

const COMP_TROPHY = { birdie: 'Birdie League', fedex: 'FedEx Cup' };

/** Season table for 'birdie' or 'fedex': events (with any entries) as columns, players as rows. */
function compTable(db, comp, seasonId) {
  const season = db.prepare('SELECT * FROM seasons WHERE id=?').get(seasonId);
  const entries = db.prepare(`SELECT cs.*, u.name, u.nickname FROM comp_scores cs JOIN events e ON e.id=cs.event_id JOIN users u ON u.id=cs.user_id
    WHERE cs.comp=? AND e.season_id=? AND e.status!='cancelled' AND (CASE cs.comp WHEN 'birdie' THEN e.counts_birdie WHEN 'fedex' THEN e.counts_fedex ELSE 1 END)=1`).all(comp, seasonId);
  const evIds = new Set(entries.map((x) => x.event_id));
  const events = seasonEvents(db, seasonId).filter((e) => evIds.has(e.id));
  const col = new Map(events.map((e, i) => [e.id, i]));
  const by = new Map();
  for (const x of entries) {
    if (!by.has(x.user_id)) by.set(x.user_id, { user_id: x.user_id, name: x.name, nickname: x.nickname, values: events.map(() => null) });
    by.get(x.user_id).values[col.get(x.event_id)] = x.value;
  }
  const rows = Soc.tableFrom([...by.values()]);
  const h = season ? holder(db, COMP_TROPHY[comp], season.year) : null;
  for (const r of rows) r.holder = !!h && h.id === r.user_id;
  return { events, rows, holder: h, season };
}

function setCompScores(db, comp, eventId, values) {
  db.transaction(() => {
    db.prepare('DELETE FROM comp_scores WHERE comp=? AND event_id=?').run(comp, eventId);
    const ins = db.prepare('INSERT INTO comp_scores(comp,event_id,user_id,value) VALUES (?,?,?,?)');
    for (const [uid, v] of values) ins.run(comp, eventId, uid, v);
  })();
}

/** FedEx points derived from an event's finishing positions (top 10 score 10..1). */
function fedexFromPositions(db, eventId) {
  return db.prepare('SELECT user_id, position FROM results WHERE event_id=? AND position IS NOT NULL').all(eventId)
    .map((r) => [r.user_id, Soc.fedexPoints(r.position)]).filter((x) => x[1] > 0);
}

// ---- Matchplay -------------------------------------------------------------------
function bracket(db, compId) {
  const comp = db.prepare('SELECT * FROM mp_comps WHERE id=?').get(compId);
  if (!comp) return null;
  const nRounds = Math.round(Math.log2(comp.size));
  const names = Soc.roundNames(nRounds);
  const all = db.prepare('SELECT * FROM mp_matches WHERE comp_id=?').all(compId);
  const at = new Map(all.map((m) => [`${m.round}:${m.slot}`, m]));
  const rounds = [];
  for (let r = 1; r <= nRounds; r++) {
    const matches = [];
    for (let s = 1; s <= Soc.matchesInRound(comp.size, r); s++) {
      const m = at.get(`${r}:${s}`) || { round: r, slot: s, p1_name: null, p2_name: null, winner: null, result: null };
      matches.push({ ...m, round: r, slot: s, status: m.winner ? 'done' : (m.p1_name && m.p2_name ? 'todo' : 'tbd') });
    }
    rounds.push({ round: r, name: names[r - 1], matches });
  }
  const fin = rounds[rounds.length - 1].matches[0];
  const champion = fin && fin.winner ? (fin.winner === 1 ? fin.p1_name : fin.p2_name) : null;
  const season = comp.season_id ? db.prepare('SELECT * FROM seasons WHERE id=?').get(comp.season_id) : null;
  return { comp, rounds, champion, holder: season ? holder(db, 'Matchplay', season.year) : null };
}

/** Save one match; when a winner is set, push them into the next round's slot. */
function saveMatch(db, compId, round, slot, { p1, p2, winner, result }) {
  const comp = db.prepare('SELECT * FROM mp_comps WHERE id=?').get(compId);
  const nRounds = Math.round(Math.log2(comp.size));
  const findUser = (n) => (n && !Soc.isBye(n) ? db.prepare('SELECT id FROM users WHERE name=? COLLATE NOCASE').get(n) : null);
  const norm = (n) => (n ? (Soc.isBye(n) ? 'Bye' : n) : null);
  const u1 = findUser(p1); const u2 = findUser(p2);
  db.transaction(() => {
    db.prepare(`INSERT INTO mp_matches(comp_id,round,slot,p1_id,p1_name,p2_id,p2_name,winner,result) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(comp_id,round,slot) DO UPDATE SET p1_id=excluded.p1_id,p1_name=excluded.p1_name,p2_id=excluded.p2_id,p2_name=excluded.p2_name,winner=excluded.winner,result=excluded.result`)
      .run(compId, round, slot, u1 ? u1.id : null, norm(p1), u2 ? u2.id : null, norm(p2), winner || null, result || null);
    if (winner && round < nRounds) {
      const nx = Soc.nextSlot(round, slot);
      const wName = winner === 1 ? norm(p1) : norm(p2); const wId = winner === 1 ? (u1 && u1.id) : (u2 && u2.id);
      db.prepare('INSERT OR IGNORE INTO mp_matches(comp_id,round,slot) VALUES (?,?,?)').run(compId, nx.round, nx.slot);
      db.prepare(`UPDATE mp_matches SET p${nx.side}_id=?, p${nx.side}_name=? WHERE comp_id=? AND round=? AND slot=?`).run(wId || null, wName, compId, nx.round, nx.slot);
    }
  })();
}

// ---- Hall of fame ----------------------------------------------------------------
function hallOfFame(db) {
  const members = db.prepare("SELECT id, name, nickname, achievements FROM users WHERE status='active'").all()
    .map((u) => { const a = Soc.parseAchievements(u.achievements); return { ...u, a, titles: Soc.titleCount(a), badges: Soc.badges(a) }; });
  const withAny = members.filter((m) => m.titles || m.a.hioc).sort((x, y) => y.titles - x.titles || y.a.major - x.a.major || x.name.localeCompare(y.name));
  const hioc = members.filter((m) => m.a.hioc).sort((x, y) => y.a.hioc - x.a.hioc || x.name.localeCompare(y.name));
  const leaders = {};
  for (const k of ['major', 'oom', 'euro', 'matchplay', 'fedex']) {
    const top = Math.max(0, ...members.map((m) => m.a[k]));
    leaders[k] = top ? { n: top, who: members.filter((m) => m.a[k] === top).map((m) => m.name) } : null;
  }
  const totals = { titles: members.reduce((s, m) => s + m.titles, 0), hioc: members.reduce((s, m) => s + m.a.hioc, 0) };
  return { rows: withAny, hioc, leaders, totals };
}

module.exports = { seasonEvents, holder, compTable, setCompScores, fedexFromPositions, bracket, saveMatch, hallOfFame };
