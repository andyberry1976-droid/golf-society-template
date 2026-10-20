'use strict';

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function playerStats(db, userId) {
  const rows = db.prepare(`SELECT r.*, e.event_date, e.title, e.scoring_basis, e.season_id FROM results r JOIN events e ON e.id=r.event_id
    WHERE r.user_id=? AND e.status='completed' ORDER BY e.event_date`).all(userId);
  const stb = rows.filter((r) => r.stableford != null).map((r) => r.stableford);
  const nets = rows.filter((r) => r.net != null).map((r) => r.net);
  const grosses = rows.filter((r) => r.gross != null).map((r) => r.gross);
  const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return {
    rounds: rows.length,
    wins: rows.filter((r) => r.position === 1).length,
    podiums: rows.filter((r) => r.position && r.position <= 3).length,
    bestGross: grosses.length ? Math.min(...grosses) : null,
    bestStableford: stb.length ? Math.max(...stb) : null,
    avgStableford: r1(avg(stb)),
    avgNet: r1(avg(nets)),
    totalPoints: rows.reduce((s, r) => s + r.points, 0),
  };
}

function titlesFor(db, userId) {
  return db.prepare(`SELECT h.year, c.name, h.detail FROM honours h JOIN honour_categories c ON c.id=h.category_id
    WHERE h.user_id=? OR h.partner_id=? ORDER BY h.year DESC, c.sort, c.name`).all(userId, userId);
}

function awardsFor(db, userId) {
  return db.prepare(`SELECT g.*, t.name, t.icon, t.tint, s.name AS season FROM award_grants g
    JOIN award_types t ON t.id=g.award_type_id JOIN seasons s ON s.id=g.season_id
    WHERE g.user_id=? ORDER BY s.year DESC, t.sort, t.name`).all(userId);
}

/** Ordered "events attended" per user to compute streaks. */
function streaks(db, { seasonId = null } = {}) {
  const P = { sid: seasonId };
  const events = db.prepare(`SELECT e.id FROM events e WHERE e.status='completed' AND (@sid IS NULL OR e.season_id=@sid) AND e.counts_oom=1
    AND EXISTS (SELECT 1 FROM results r WHERE r.event_id=e.id) ORDER BY e.event_date, e.id`).all(P);
  const res = db.prepare(`SELECT r.event_id, r.user_id, r.position FROM results r JOIN events e ON e.id=r.event_id WHERE e.status='completed' AND (@sid IS NULL OR e.season_id=@sid)`).all(P);
  const map = new Map();
  for (const r of res) map.set(r.event_id + ':' + r.user_id, r);
  const users = db.prepare("SELECT id, name FROM users").all();
  let bestAtt = { n: 0 }; let bestPod = { n: 0 }; let bestWin = { n: 0 };
  for (const u of users) {
    let att = 0; let pod = 0; let win = 0;
    for (const e of events) {
      const r = map.get(e.id + ':' + u.id);
      if (r) { att++; if (att > bestAtt.n) bestAtt = { n: att, name: u.name, id: u.id }; } else att = 0;
      if (r && r.position && r.position <= 3) { pod++; if (pod > bestPod.n) bestPod = { n: pod, name: u.name, id: u.id }; } else if (r) pod = 0; // missing an event doesn't break a podium streak
      if (r && r.position === 1) { win++; if (win > bestWin.n) bestWin = { n: win, name: u.name, id: u.id }; } else if (r) win = 0;
    }
  }
  return { attendance: bestAtt, podium: bestPod, win: bestWin };
}

/** All records derived from the DB (plus admin-entered "fun" records). */
/** Society records. opts.seasonId limits event-based records to one season (null = all seasons). */
function records(db, { seasonId = null } = {}) {
  const P = { sid: seasonId };
  const out = [];
  const player = (id, name) => ({ id, name });
  // Course records (lowest gross per course)
  const courses = db.prepare(`SELECT c.id, c.name, c.tee, c.par FROM courses c WHERE EXISTS (
    SELECT 1 FROM results r JOIN events e ON e.id=r.event_id WHERE e.course_id=c.id AND r.gross IS NOT NULL AND (@sid IS NULL OR e.season_id=@sid)) ORDER BY c.name`).all(P);
  for (const c of courses) {
    const b = db.prepare(`SELECT r.gross, r.user_id, u.name, e.title, e.event_date, e.id AS event_id FROM results r JOIN events e ON e.id=r.event_id
      JOIN users u ON u.id=r.user_id WHERE e.course_id=? AND r.gross IS NOT NULL AND e.status='completed' AND (@sid IS NULL OR e.season_id=@sid) ORDER BY r.gross, e.event_date LIMIT 1`).get(c.id, P);
    if (b) out.push({ key: 'course-' + c.id, label: `Course record · ${c.name}`, value: String(b.gross), holder: player(b.user_id, b.name), meta: `Gross, par ${c.par} · ${b.title}`, date: b.event_date, event_id: b.event_id, icon: 's-flag', tint: '#d9fbe9' });
  }
  const lowNet = db.prepare(`SELECT r.net, r.user_id, u.name, e.title, e.event_date, e.id AS event_id FROM results r JOIN events e ON e.id=r.event_id JOIN users u ON u.id=r.user_id
    WHERE r.net IS NOT NULL AND e.status='completed' AND (@sid IS NULL OR e.season_id=@sid) AND e.counts_handicap=1 ORDER BY r.net, e.event_date LIMIT 1`).get(P);
  if (lowNet) out.push({ key: 'low-net', label: 'Lowest net round', value: `${lowNet.net} net`, holder: player(lowNet.user_id, lowNet.name), meta: lowNet.title, date: lowNet.event_date, event_id: lowNet.event_id, icon: 's-star', tint: '#fff3b8' });
  const hiStb = db.prepare(`SELECT r.stableford, r.user_id, u.name, e.title, e.event_date, e.id AS event_id FROM results r JOIN events e ON e.id=r.event_id JOIN users u ON u.id=r.user_id
    WHERE r.stableford IS NOT NULL AND e.status='completed' AND (@sid IS NULL OR e.season_id=@sid) AND e.counts_handicap=1 ORDER BY r.stableford DESC, e.event_date LIMIT 1`).get(P);
  if (hiStb) out.push({ key: 'hi-stb', label: 'Highest Stableford', value: `${hiStb.stableford} pts`, holder: player(hiStb.user_id, hiStb.name), meta: hiStb.title, date: hiStb.event_date, event_id: hiStb.event_id, icon: 's-trophy', tint: '#fff3b8' });
  // Biggest winning margin
  let big = null;
  for (const e of db.prepare("SELECT * FROM events e WHERE e.status='completed' AND (@sid IS NULL OR e.season_id=@sid) AND scoring_basis IN ('stableford','stroke_net','stroke_gross')").all(P)) {
    const rows = db.prepare('SELECT r.*, u.name FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=?').all(e.id);
    const val = (r) => (e.scoring_basis === 'stableford' ? r.stableford : e.scoring_basis === 'stroke_net' ? r.net : (r.gross ?? r.ags));
    const vs = rows.filter((r) => val(r) != null).sort((a, b) => (e.scoring_basis === 'stableford' ? val(b) - val(a) : val(a) - val(b)));
    if (vs.length < 2) continue;
    const margin = Math.abs(val(vs[0]) - val(vs[1]));
    if (!big || margin > big.margin) big = { margin, e, w: vs[0], unit: e.scoring_basis === 'stableford' ? 'pts' : 'shots' };
  }
  if (big) out.push({ key: 'margin', label: 'Biggest winning margin', value: `${big.margin} ${big.unit}`, holder: player(big.w.user_id, big.w.name), meta: big.e.title, date: big.e.event_date, event_id: big.e.id, icon: 's-up', tint: '#d9fbe9' });
  const st = streaks(db, { seasonId });
  if (st.win.n > 1) out.push({ key: 'win-streak', label: 'Longest winning streak', value: `${st.win.n} in a row`, holder: player(st.win.id, st.win.name), meta: 'Consecutive events played, all won', icon: 's-spark', tint: '#e6defa' });
  if (st.podium.n > 1) out.push({ key: 'podium-streak', label: 'Longest podium streak', value: `${st.podium.n} top-3s`, holder: player(st.podium.id, st.podium.name), meta: 'Consecutive events played finishing top 3', icon: 's-star', tint: '#ffe9c7' });
  if (st.attendance.n > 1) out.push({ key: 'att-streak', label: 'Longest attendance streak', value: `${st.attendance.n} events`, holder: player(st.attendance.id, st.attendance.name), meta: 'Never missed a tee-off', icon: 's-heart', tint: '#fde1f2' });
  const mostWins = db.prepare(`SELECT u.id, u.name, COUNT(*) n FROM results r JOIN events e ON e.id=r.event_id JOIN users u ON u.id=r.user_id
    WHERE r.position=1 AND e.status='completed' AND (@sid IS NULL OR e.season_id=@sid) AND e.format IN ('stableford','medal','gross') GROUP BY u.id ORDER BY n DESC, u.name LIMIT 1`).get(P);
  if (mostWins) out.push({ key: 'most-wins', label: 'Most individual wins', value: String(mostWins.n), holder: player(mostWins.id, mostWins.name), meta: 'Stableford & stroke-play events', icon: 's-trophy', tint: '#d9fbe9' });
  const mostPlayed = db.prepare(`SELECT u.id, u.name, COUNT(*) n FROM results r JOIN events e ON e.id=r.event_id JOIN users u ON u.id=r.user_id
    WHERE e.status='completed' AND (@sid IS NULL OR e.season_id=@sid) GROUP BY u.id ORDER BY n DESC, u.name LIMIT 1`).get(P);
  if (mostPlayed) out.push({ key: 'most-played', label: 'Most society rounds', value: String(mostPlayed.n), holder: player(mostPlayed.id, mostPlayed.name), meta: 'Events played in the app', icon: 's-flag', tint: '#fde1f2' });
  const lowHi = db.prepare(`SELECT h.index_after v, u.id, u.name, h.effective_on FROM handicap_history h JOIN users u ON u.id=h.user_id ORDER BY h.index_after, h.effective_on LIMIT 1`).get();
  if (lowHi) out.push({ key: 'low-hi', label: 'Lowest handicap index ever', value: lowHi.v.toFixed(1), holder: player(lowHi.id, lowHi.name), meta: 'Reached ' + lowHi.effective_on, date: lowHi.effective_on, icon: 's-up', tint: '#e6defa' });
  const drop = db.prepare(`SELECT (h.index_before-h.index_after) d, u.id, u.name, h.label, h.effective_on FROM handicap_history h JOIN users u ON u.id=h.user_id
    WHERE h.index_before IS NOT NULL AND h.source IN ('event','extra') ORDER BY d DESC LIMIT 1`).get();
  if (drop && drop.d > 0) out.push({ key: 'drop', label: 'Biggest one-round handicap cut', value: `−${drop.d.toFixed(1)}`, holder: player(drop.id, drop.name), meta: drop.label, date: drop.effective_on, icon: 's-up', tint: '#d9fbe9' });
  for (const c of db.prepare('SELECT c.*, u.name AS uname FROM custom_records c LEFT JOIN users u ON u.id=c.holder_user_id ORDER BY c.sort, c.id').all()) {
    out.push({ key: 'custom-' + c.id, custom: true, label: c.title, value: c.value, holder: c.holder_user_id ? player(c.holder_user_id, c.uname) : { id: null, name: c.holder_text || '—' }, meta: c.detail || '', icon: c.icon, tint: c.tint });
  }
  return out;
}

/** Suggested award winners for a season (admin picks; these are just hints). */
function awardSuggestions(db, seasonId) {
  const out = {};
  const rows = db.prepare(`SELECT r.user_id, u.name, r.stableford, r.net, r.points, r.position, r.idx_at_event
    FROM results r JOIN events e ON e.id=r.event_id JOIN users u ON u.id=r.user_id
    WHERE e.season_id=? AND e.status='completed' AND e.counts_handicap=1`).all(seasonId);
  const by = new Map();
  for (const r of rows) { if (!by.has(r.user_id)) by.set(r.user_id, { name: r.name, id: r.user_id, stb: [], pts: 0, n: 0 }); const o = by.get(r.user_id); if (r.stableford != null) o.stb.push(r.stableford); o.pts += r.points; o.n++; }
  const list = [...by.values()].filter((o) => o.n >= 3);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  if (list.length) {
    const spoon = list.slice().sort((a, b) => a.pts - b.pts)[0];
    out.wooden_spoon = { user_id: spoon.id, text: `${spoon.name} — fewest Order of Merit points (${spoon.pts})` };
    const sb = list.filter((o) => o.stb.length >= 3).sort((a, b) => mean(b.stb) - mean(a.stb))[0];
    if (sb) out.sandbagger = { user_id: sb.id, text: `${sb.name} — average ${mean(sb.stb).toFixed(1)} stableford pts (36 = playing to handicap)` };
    const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
    const cons = list.filter((o) => o.stb.length >= 4).sort((a, b) => sd(a.stb) - sd(b.stb))[0];
    if (cons) out.consistency = { user_id: cons.id, text: `${cons.name} — most consistent stableford scores (σ ${sd(cons.stb).toFixed(1)})` };
  }
  const season = db.prepare('SELECT * FROM seasons WHERE id=?').get(seasonId);
  if (season) {
    const imp = db.prepare(`SELECT u.id, u.name, (SELECT index_after FROM handicap_history h WHERE h.user_id=u.id AND h.effective_on<? ORDER BY seq DESC LIMIT 1) AS startv, u.handicap_index AS endv
      FROM users u WHERE u.status='active'`).all(season.start_date).filter((x) => x.startv != null && x.endv != null).sort((a, b) => (a.endv - a.startv) - (b.endv - b.startv))[0];
    if (imp && imp.endv < imp.startv) out.most_improved = { user_id: imp.id, text: `${imp.name} — index down ${(imp.startv - imp.endv).toFixed(1)} since the season began` };
  }
  return out;
}

module.exports = { playerStats, titlesFor, awardsFor, records, streaks, awardSuggestions, r1 };
