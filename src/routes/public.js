'use strict';
const express = require('express');
const q = require('../lib/queries');
const standings = require('../lib/standings');
const stats = require('../lib/stats');
const { wrap } = require('../lib/guards');
const rsvpLib = require('../lib/rsvp');
const H = require('../lib/handicap');

const router = express.Router();

router.get('/healthz', (req, res) => {
  req.app.locals.db.prepare('SELECT 1').get();
  res.type('text').send('ok');
});

router.get('/', wrap((req, res) => {
  const db = req.app.locals.db;
  if (req.settings.members_only === '1' && !req.user) return res.render('home', { locked: true, title: null, active: 'home', upcoming: [], latest: null, podium: [], hl: [], om: [], season: null, records: [], honours: [], awards: [], rsvps: new Map(), nextEvent: null, bdays: [] });
  const upcoming = q.upcomingEvents(db, 4).filter((e) => e.status === 'scheduled');
  const season = q.currentSeason(db);
  const latest = q.latestResultEvent(db);
  const podium = latest ? q.eventResults(db, latest.id).filter((r) => r.position && r.position <= 3).slice(0, 3) : [];
  const hl = standings.handicapLeaderboard(db);
  const om = season ? standings.orderOfMeritWithMovement(db, season.id) : { rows: [] };
  const recs = stats.records(db, { seasonId: season ? season.id : null });
  const honours = db.prepare(`SELECT h.*, c.name AS cat, u.name AS uname, p.name AS pname FROM honours h JOIN honour_categories c ON c.id=h.category_id
    LEFT JOIN users u ON u.id=h.user_id LEFT JOIN users p ON p.id=h.partner_id ORDER BY h.year DESC, c.sort, c.name LIMIT 8`).all();
  const awardSeason = db.prepare(`SELECT s.id FROM seasons s WHERE EXISTS (SELECT 1 FROM award_grants g WHERE g.season_id=s.id) ORDER BY s.year DESC LIMIT 1`).get();
  const awards = awardSeason ? db.prepare(`SELECT g.*, t.name, t.icon, t.tint, u.name AS uname, u.nickname, u.id AS uid FROM award_grants g JOIN award_types t ON t.id=g.award_type_id
    JOIN users u ON u.id=g.user_id WHERE g.season_id=? ORDER BY t.sort, t.name LIMIT 6`).all(awardSeason.id) : [];
  const bits = latest && latest.highlights ? latest.highlights.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  res.render('home', {
    title: null, active: 'home', locked: false, upcoming, nextEvent: upcoming[0] || null, latest, podium, bits,
    hl, om, season, records: recs.slice(0, 6), honours, awards, rsvps: q.myRsvps(db, req.user && req.user.id),
    bdays: req.features.on.birthdays ? require('../lib/birthdays').list(db).today : [], bdayDate: require('../lib/birthdays').londonToday(),
  });
}));

// ---- Events ---------------------------------------------------------------
router.get('/events', wrap((req, res) => {
  const db = req.app.locals.db;
  const all = q.seasons(db);
  const sel = req.query.season === 'all' ? null : q.pickSeason(db, req.query.season);
  res.render('events', {
    title: 'Events', active: 'events', upcoming: q.upcomingEvents(db), past: q.pastEvents(db, { seasonId: sel && sel.id }),
    seasons: all, selSeason: sel, rsvps: q.myRsvps(db, req.user && req.user.id),
  });
}));

router.get('/events/:id(\\d+)', wrap((req, res) => {
  const db = req.app.locals.db;
  const e = q.getEvent(db, Number(req.params.id));
  if (!e) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  const going = db.prepare(`SELECT u.id,u.name,u.nickname,u.handicap_index FROM rsvps r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND r.status='going' ORDER BY r.updated_at, u.name`).all(e.id);
  const waitlist = db.prepare(`SELECT u.id,u.name,u.nickname FROM rsvps r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND r.status='waitlist' ORDER BY r.queue_seq, r.rowid`).all(e.id);
  const mine = req.user ? db.prepare('SELECT * FROM rsvps WHERE event_id=? AND user_id=?').get(e.id, req.user.id) : null;
  const results = q.eventResults(db, e.id);
  let ch = null;
  if (req.user && req.user.handicap_index != null && e.course_slope) {
    const c = H.courseHandicap(req.user.handicap_index, { slope: e.course_slope, rating: e.course_rating, par: e.course_par });
    ch = { course: c, playing: H.playingHandicap(c, e.allowance_pct) };
  }
  const isPast = e.status === 'completed' || e.event_date < q.today();
  res.render('event', {
    title: e.title, active: 'events', e, going, waitlist, mine, myPos: mine && mine.status === 'waitlist' ? rsvpLib.waitlistPosition(db, e.id, req.user.id) : null,
    results, ch, isPast, field: (!isPast && !req.features.on.rsvp) ? require('../lib/field').list(db, e.id) : [],
    odds: (() => { // fun odds: only on the next upcoming event, only before results exist
      if (!req.features.on.odds || isPast || results.length) return null;
      const O = require('../lib/odds'); const nx = O.nextEvent(db, q.today());
      return nx && nx.id === e.id ? O.compute(db, e) : null;
    })(),
    members: req.user && (req.user.role !== 'member') ? q.activeMembers(db) : [],
    notGoing: db.prepare("SELECT COUNT(*) n FROM rsvps WHERE event_id=? AND status='not_going'").get(e.id).n,
    bits: e.highlights ? e.highlights.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [],
  });
}));

// ---- Players --------------------------------------------------------------
const SORTS = { name: 'name', hcp: 'handicap_index', wins: 'wins', rounds: 'rounds' };
router.get('/players', wrap((req, res) => {
  const db = req.app.locals.db;
  const term = String(req.query.q || '').trim().slice(0, 60);
  const sort = SORTS[req.query.sort] ? req.query.sort : 'name';
  const defDir = sort === 'wins' || sort === 'rounds' ? 'desc' : 'asc';
  const dir = req.query.dir === 'asc' || req.query.dir === 'desc' ? req.query.dir : defDir;
  // rounds & wins: current season by default (?season=<id> | all)
  const allSeasons = req.query.season === 'all';
  const season = allSeasons ? null : q.pickSeason(db, req.query.season);
  const sid = season ? season.id : null;
  const rows = db.prepare(`SELECT u.id,u.name,u.nickname,u.handicap_index,u.role,u.home_course,
      (SELECT COUNT(*) FROM results r JOIN events e ON e.id=r.event_id WHERE r.user_id=u.id AND e.status='completed' AND (@sid IS NULL OR e.season_id=@sid)) AS rounds,
      (SELECT COUNT(*) FROM results r JOIN events e ON e.id=r.event_id WHERE r.user_id=u.id AND e.status='completed' AND r.position=1 AND (@sid IS NULL OR e.season_id=@sid)) AS wins
    FROM users u WHERE u.status='active' AND (? = '' OR u.name LIKE ? ESCAPE '\\' OR IFNULL(u.nickname,'') LIKE ? ESCAPE '\\')`)
    .all({ sid }, term, '%' + term.replace(/[\\%_]/g, '\\$&') + '%', '%' + term.replace(/[\\%_]/g, '\\$&') + '%');
  const surname = (n) => n.trim().split(/\s+/).pop().toLowerCase();
  rows.sort((a, b) => {
    let r;
    if (sort === 'name') r = surname(a.name).localeCompare(surname(b.name)) || a.name.localeCompare(b.name);
    else r = (a[SORTS[sort]] ?? 99) - (b[SORTS[sort]] ?? 99);
    return (dir === 'asc' ? r : -r) || a.id - b.id;
  });
  const total = db.prepare("SELECT COUNT(*) n FROM users WHERE status='active'").get().n;
  res.render('players', { title: 'Players', active: 'players', rows, term, sort, dir, total, seasons: q.seasons(db), season, allSeasons });
}));

router.get('/players/:id(\\d+)', wrap((req, res) => {
  const db = req.app.locals.db;
  const p = db.prepare("SELECT id,name,nickname,role,status,handicap_index,home_course,bio,joined_on,lowest_index,achievements FROM users WHERE id=? AND status='active'").get(Number(req.params.id));
  if (!p) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such player.' });
  const history = db.prepare('SELECT * FROM handicap_history WHERE user_id=? ORDER BY seq').all(p.id);
  const results = db.prepare(`SELECT r.*, e.title, e.event_date, e.id AS eid, e.scoring_basis, e.format FROM results r JOIN events e ON e.id=r.event_id
    WHERE r.user_id=? AND e.status='completed' ORDER BY e.event_date DESC, e.id DESC`).all(p.id);
  const lastWithDiff = db.prepare(`SELECT r.differential, e.title FROM results r JOIN events e ON e.id=r.event_id WHERE r.user_id=? AND r.differential IS NOT NULL ORDER BY e.event_date DESC LIMIT 20`).all(p.id);
  res.render('profile', {
    title: p.name, active: 'players', p, history, results, st: stats.playerStats(db, p.id), titles: stats.titlesFor(db, p.id),
    awards: stats.awardsFor(db, p.id), diffs: lastWithDiff.length,
    own: !!req.user && req.user.id === p.id, extra: profileExtras(db, p, req.settings),
  });
}));

function profileExtras(db, p, S) {
  const Soc = require('../lib/society');
  const comps = require('../lib/comps');
  const cfg = Soc.parseSocietyHcp(S.society_hcp);
  const a = Soc.parseAchievements(p.achievements);
  const season = q.currentSeason(db);
  const jan = season ? db.prepare("SELECT index_after FROM handicap_history WHERE user_id=? AND effective_on<=? ORDER BY seq DESC LIMIT 1").get(p.id, season.start_date) : null;
  const seasonTotals = {};
  if (season) {
    for (const c of ['birdie', 'fedex']) { const t = comps.compTable(db, c, season.id); const r = t.rows.find((x) => x.user_id === p.id); seasonTotals[c] = r ? { total: r.total, rank: r.rank, n: t.rows.length } : null; }
    const om = standings.orderOfMerit(db, season.id).find((x) => x.user_id === p.id);
    seasonTotals.oom = om ? { total: om.total, rank: om.rank } : null;
  }
  const lowest = [p.lowest_index, ...db.prepare('SELECT index_after FROM handicap_history WHERE user_id=?').all(p.id).map((h) => h.index_after)].filter((v) => v != null);
  return {
    badges: Soc.badges(a), titles: Soc.titleCount(a), code: p.achievements, season,
    playing: Soc.playingFromIndex(p.handicap_index), cat: Soc.category(p.handicap_index, cfg),
    lowest: lowest.length ? Math.min(...lowest) : null, jan: jan ? jan.index_after : null, seasonTotals,
  };
}

// ---- Standings, records, honours, awards ----------------------------------
/** players x events grid of OoM points, marking which scores count towards best-N. */
function omGrid(db, seasonId, omRows, scheme) {
  const events = db.prepare(`SELECT e.id, e.title, e.event_date, c.name AS venue FROM events e LEFT JOIN courses c ON c.id=e.course_id
    WHERE e.season_id=? AND e.status='completed' AND e.counts_oom=1 ORDER BY e.event_date, e.id`).all(seasonId);
  const col = new Map(events.map((e, i) => [e.id, i]));
  const pts = db.prepare(`SELECT r.user_id, r.event_id, r.points FROM results r JOIN events e ON e.id=r.event_id WHERE e.season_id=? AND e.status='completed' AND e.counts_oom=1`).all(seasonId);
  const by = new Map(omRows.map((o) => [o.user_id, { user_id: o.user_id, name: o.name, total: o.total, values: events.map(() => null) }]));
  for (const p of pts) { const r = by.get(p.user_id); if (r) r.values[col.get(p.event_id)] = p.points; }
  const rows = [...by.values()];
  for (const r of rows) {
    const order = r.values.map((v, i) => ({ v, i })).filter((x) => x.v != null).sort((a, b) => b.v - a.v || a.i - b.i);
    const keep = new Set((scheme && scheme.bestN ? order.slice(0, scheme.bestN) : order).map((x) => x.i));
    r.counted = r.values.map((v, i) => (v == null ? null : keep.has(i)));
  }
  return { events, rows };
}

router.get('/standings', wrap((req, res) => {
  const db = req.app.locals.db;
  const season = q.pickSeason(db, req.query.season);
  const hl = standings.handicapLeaderboard(db);
  const om = season ? standings.orderOfMeritWithMovement(db, season.id) : { rows: [] };
  const P = require('../lib/points');
  const scheme = season ? P.parseScheme(season.scheme, P.parseScheme(req.settings.oom_default_scheme)) : null;
  const eventsCounted = season ? db.prepare("SELECT COUNT(*) n FROM events WHERE season_id=? AND status='completed' AND counts_oom=1").get(season.id).n : 0;
  const grid = season ? omGrid(db, season.id, om.rows, scheme) : { events: [], rows: [] };
  const omHolder = season ? require('../lib/comps').holder(db, 'Order of Merit', season.year) : null;
  for (const r of om.rows) r.holder = !!omHolder && omHolder.id === r.user_id;
  res.render('standings', { title: 'Order of Merit', active: 'standings', seasons: q.seasons(db), season, hl, om, scheme, eventsCounted, grid, omHolder, describe: P.describe });
}));

router.get('/records', wrap((req, res) => {
  const db = req.app.locals.db;
  // default: the current season (as before a second season existed); ?season=<id> or ?season=all for every season
  const all = req.query.season === 'all';
  const season = all ? null : q.pickSeason(db, req.query.season);
  res.render('records', { title: 'Records', active: 'records', records: stats.records(db, { seasonId: season ? season.id : null }), seasons: q.seasons(db), season, allSeasons: all });
}));

router.get('/honours', wrap((req, res) => {
  const db = req.app.locals.db;
  const years = db.prepare('SELECT DISTINCT year FROM honours ORDER BY year DESC').all().map((r) => r.year);
  const yr = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : null;
  const rows = db.prepare(`SELECT h.*, c.name AS cat, c.sort, u.name AS uname, p.name AS pname, u.nickname FROM honours h JOIN honour_categories c ON c.id=h.category_id
    LEFT JOIN users u ON u.id=h.user_id LEFT JOIN users p ON p.id=h.partner_id WHERE (? IS NULL OR h.year=?) ORDER BY h.year DESC, c.sort, c.name`).all(yr, yr);
  const open = db.prepare("SELECT s.* FROM seasons s WHERE s.status='open' ORDER BY s.year DESC").all();
  res.render('honours', { title: 'Roll of honour', active: 'honours', years, yr, rows, open });
}));

router.get('/awards', wrap((req, res) => {
  const db = req.app.locals.db;
  // seasons with special awards or recorded scores (stats awards)
  const withGrants = db.prepare(`SELECT s.* FROM seasons s WHERE EXISTS (SELECT 1 FROM award_grants g WHERE g.season_id=s.id)
    OR EXISTS (SELECT 1 FROM results r JOIN events e ON e.id=r.event_id WHERE e.season_id=s.id AND e.status='completed') ORDER BY s.year DESC`).all();
  const sel = withGrants.find((s) => String(s.id) === String(req.query.season)) || withGrants[0] || null;
  const SA = require('../lib/statawards'); const D = SA.load(db);
  const stats = sel ? SA.forSeason(db, sel.id, D) : null;
  const allTime = SA.allTime(db, D);
  const grants = sel ? db.prepare(`SELECT g.*, t.name, t.icon, t.tint, u.name AS uname, u.nickname, u.id AS uid FROM award_grants g JOIN award_types t ON t.id=g.award_type_id
    JOIN users u ON u.id=g.user_id WHERE g.season_id=? ORDER BY t.sort, t.name, u.name`).all(sel.id) : [];
  res.render('awards', { title: 'Awards', active: 'awards', seasons: withGrants, sel, grants, stats, allTime });
}));

module.exports = router;
