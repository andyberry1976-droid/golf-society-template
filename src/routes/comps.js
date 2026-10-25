'use strict';
/** Public pages for the side competitions: Birdie League, FedEx, matchplay, majors, hall of fame, rules. */
const express = require('express');
const q = require('../lib/queries');
const comps = require('../lib/comps');
const Soc = require('../lib/society');
const { tournamentBoard } = require('../lib/engine');
const { wrap } = require('../lib/guards');

const router = express.Router();
// matchplay competitions, newest season first
const MP_ORDER = 'SELECT c.* FROM mp_comps c LEFT JOIN seasons s ON s.id=c.season_id ORDER BY s.year DESC, c.id DESC';
// members-only sites hide these from visitors like the other public pages
router.use(['/competitions', '/birdie-league', '/fedex', '/matchplay', '/majors', '/hall-of-fame', '/handicaps'], (req, res, next) => {
  if (req.settings.members_only === '1' && !req.user) return res.redirect('/login');
  next();
});

router.get('/competitions', wrap((req, res) => {
  const db = req.app.locals.db;
  const season = q.currentSeason(db);
  const lead = (comp) => (season ? comps.compTable(db, comp, season.id).rows[0] : null);
  const mp = (season && db.prepare('SELECT id FROM mp_comps WHERE season_id=? ORDER BY id DESC LIMIT 1').get(season.id)) || db.prepare(MP_ORDER + ' LIMIT 1').get();
  res.render('competitions', {
    title: 'Competitions', active: 'comps', season, birdie: lead('birdie'), fedex: lead('fedex'),
    tours: season ? db.prepare('SELECT * FROM tournaments WHERE season_id=? ORDER BY id').all(season.id).map((t) => ({ ...t, board: tournamentBoard(db, t.id) })) : [],
    mp: mp ? comps.bracket(db, mp.id) : null,
  });
}));

function compPage(comp, view, title) {
  return wrap((req, res) => {
    const db = req.app.locals.db;
    const season = q.pickSeason(db, req.query.season);
    const t = season ? comps.compTable(db, comp, season.id) : { events: [], rows: [], holder: null };
    res.render(view, { title, active: 'comps', seasons: q.seasons(db), season, t });
  });
}
router.get('/birdie-league', compPage('birdie', 'birdie', 'Birdie League'));
router.get('/fedex', compPage('fedex', 'fedex', 'FedEx Cup'));

router.get('/matchplay', wrap((req, res) => {
  const db = req.app.locals.db;
  const all = db.prepare(MP_ORDER).all();
  const cur = q.currentSeason(db);
  const sel = all.find((c) => String(c.id) === String(req.query.comp)) || (cur && all.find((c) => c.season_id === cur.id)) || all[0];
  res.render('matchplay', { title: 'Matchplay', active: 'comps', all, b: sel ? comps.bracket(db, sel.id) : null });
}));

router.get('/majors', wrap((req, res) => {
  const db = req.app.locals.db;
  const allSeasons = req.query.season === 'all';
  const season = allSeasons ? null : q.pickSeason(db, req.query.season);
  const tours = db.prepare('SELECT t.*, s.name AS season_name FROM tournaments t JOIN seasons s ON s.id=t.season_id WHERE (? IS NULL OR t.season_id=?) ORDER BY s.year DESC, t.id').all(season && season.id, season && season.id)
    .map((t) => ({ ...t, board: tournamentBoard(db, t.id) }));
  res.render('majors', { title: 'Majors & Euro', active: 'comps', tours, seasons: q.seasons(db), season, allSeasons });
}));

router.get('/hall-of-fame', wrap((req, res) => {
  const db = req.app.locals.db;
  res.render('hall-of-fame', { title: 'Hall of fame', active: 'fame', h: comps.hallOfFame(db), keys: Soc.TITLE_KEYS });
}));

router.get('/handicaps', wrap((req, res) => {
  const db = req.app.locals.db;
  const cfg = Soc.parseSocietyHcp(req.settings.society_hcp);
  const cur = q.currentSeason(db);
  const season = q.pickSeason(db, req.query.season);
  if (season && cur && season.id !== cur.id) {
    // a past season: the handicap records as published that year (history; current handicaps are unchanged)
    const past = db.prepare(`SELECT h.*, u.name, u.nickname, u.status, u.id FROM season_handicaps h JOIN users u ON u.id=h.user_id WHERE h.season_id=? ORDER BY h.rank, u.name`).all(season.id)
      .map((r) => { const a = Soc.parseAchievements(r.achievements); return { ...r, badges: Soc.badges(a) }; });
    return res.render('handicaps', { title: `Handicap Records ${season.name}`, active: 'handicaps', rows: [], past, keys: Soc.TITLE_KEYS, season, seasons: q.seasons(db) });
  }
  const jan = db.prepare('SELECT index_after FROM handicap_history WHERE user_id=? AND effective_on<=? ORDER BY seq DESC LIMIT 1');
  const hist = db.prepare('SELECT MIN(index_after) v FROM handicap_history WHERE user_id=?');
  const rows = db.prepare("SELECT id,name,nickname,handicap_index,lowest_index,achievements,subs_paid FROM users WHERE status='active' AND handicap_index IS NOT NULL").all()
    .map((u) => {
      const a = Soc.parseAchievements(u.achievements);
      const h = hist.get(u.id).v;
      const j = season ? jan.get(u.id, season.start_date) : null;
      return { ...u, badges: Soc.badges(a), jan: j ? j.index_after : null, playing: Soc.playingFromIndex(u.handicap_index), cat: Soc.category(u.handicap_index, cfg),
        lowest: [u.lowest_index, h].filter((v) => v != null).reduce((m, v) => Math.min(m, v), Infinity) };
    })
    .sort((a, b) => a.handicap_index - b.handicap_index || a.name.localeCompare(b.name));
  rows.forEach((r, i) => { r.rank = i && rows[i - 1].handicap_index === r.handicap_index ? rows[i - 1].rank : i + 1; });
  res.render('handicaps', { title: 'Handicap Records', active: 'handicaps', rows, past: null, keys: Soc.TITLE_KEYS, season, seasons: q.seasons(db) });
}));

router.get('/ryder-cup', wrap((req, res) => {
  const db = req.app.locals.db;
  const names = new Map(db.prepare('SELECT id,name,status FROM users').all().map((u) => [u.id, u]));
  const nm = (ids) => String(ids).split(',').filter(Boolean).map((i) => (names.get(+i) || { name: '?' }).name);
  const cups = db.prepare('SELECT * FROM ryder_cups ORDER BY year DESC').all().map((c) => {
    const ms = db.prepare('SELECT * FROM ryder_matches WHERE cup_id=? ORDER BY session_no, match_no').all(c.id);
    const pa = (w) => (w === 'A' ? 1 : w === 'H' ? 0.5 : 0);
    const pts = {}; const sessions = []; let ra = 0; let rb = 0;
    for (const m of ms) {
      let s = sessions[m.session_no - 1];
      if (!s) { s = sessions[m.session_no - 1] = { name: m.session_name, a: 0, b: 0, matches: [] }; }
      const p = pa(m.winner); s.a += p; s.b += 1 - p;
      for (const i of m.a_ids.split(',')) pts[i] = (pts[i] || 0) + p;
      for (const i of m.b_ids.split(',')) pts[i] = (pts[i] || 0) + 1 - p;
      s.matches.push({ ...m, a: nm(m.a_ids), b: nm(m.b_ids) });
    }
    for (const s of sessions) { ra += s.a; rb += s.b; s.ra = ra; s.rb = rb; }
    const players = db.prepare('SELECT p.*, u.name, u.status FROM ryder_players p JOIN users u ON u.id=p.user_id WHERE p.cup_id=?').all(c.id)
      .map((p) => ({ ...p, points: pts[p.user_id] || 0 }))
      .sort((x, y) => y.points - x.points || x.name.localeCompare(y.name));
    return { ...c, captainA: nm(c.captain_a_id)[0], captainB: nm(c.captain_b_id)[0], sessions, teamA: players.filter((p) => p.team === 'A'), teamB: players.filter((p) => p.team === 'B') };
  });
  res.render('ryder', { title: 'Ryder Cup', active: 'comps', cups });
}));

router.get('/texas-scramble', (req, res) => res.render('scramble', { title: 'Texas Scramble', active: 'comps', events: require('../lib/scramble').list(req.app.locals.db) }));

router.get('/birthdays', wrap((req, res) => {
  const db = req.app.locals.db; const B = require('../lib/birthdays');
  const today = B.londonToday(); const L = B.list(db, today);
  const people = L.today.map((p) => ({ ...p, highlights: B.highlights(db, p.id) }));
  res.render('birthdays', { title: 'Birthdays', active: 'birthdays', today, todayLabel: B.dayMonth(today), people, upcoming: L.upcoming });
}));

// the published price list (sites/<site>/fantasy-prices.json) for the next Fantasy League season
function fantasyBase(req) {
  const FL = require('../lib/fantasy'); const fs = require('fs'); const path = require('path');
  const site = require('../site').load(); const file = site && site.dir && path.join(site.dir, 'fantasy-prices.json');
  const { R, places } = FL.rulesFrom(req.settings);
  let prices = file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (!prices) { // no hand-tuned file: generate from the latest season with results
    const db = req.app.locals.db; const y = db.prepare("SELECT MAX(s.year) y FROM seasons s JOIN events e ON e.season_id=s.id WHERE e.status='completed'").get().y;
    prices = y ? FL.livePrices(db, y, { R, places }) : null;
  }
  const season = (prices && prices.season) || (q.currentSeason(req.app.locals.db) || {}).year || new Date().getFullYear();
  return { R, PP: places, prices, season };
}
function fantasyPage(req, res, extra = {}) {
  const db = req.app.locals.db; const FA = require('../lib/fantasy-admin');
  const { R, PP, prices, season } = fantasyBase(req);
  const added = db.prepare('SELECT COUNT(*) n FROM fantasy_pool WHERE season=?').get(season).n;
  const shown = prices || added ? { season, basedOn: prices && prices.basedOn, players: FA.pool(db, season, prices) } : null;
  const isAdmin = !!(req.user && req.user.role === 'admin');
  res.render('fantasy', {
    title: 'Fantasy League', active: 'fantasy', R, PP, prices: shown, teams: FA.teams(db, season), isAdmin,
    fa: isAdmin ? { season, members: db.prepare("SELECT id, name FROM users WHERE status='active' ORDER BY name").all(), errors: {}, values: {}, form: null, ...extra } : null,
  });
}
router.get('/fantasy-league', (req, res) => fantasyPage(req, res));

// ---- Fantasy League admin: add golfers to the pool, enter teams on someone's behalf (admin only; CSRF checked app-wide) ----
const faAdmin = [require('../lib/guards').adminOnly];
const faDone = (req, res, r, okMsg, form) => {
  if (!r.ok) { res.status(422); return fantasyPage(req, res, { errors: r.errors || {}, values: r.values || {}, form }); }
  req.flash('ok', okMsg); res.redirect('/fantasy-league#fl-admin');
};
router.post('/fantasy-league/admin/players', faAdmin, wrap((req, res) => {
  const db = req.app.locals.db; const FA = require('../lib/fantasy-admin'); const { prices, season } = fantasyBase(req);
  const r = FA.addPlayer(db, season, req.body, prices, req.user.id);
  if (r.ok) q.audit(db, req.user.id, 'fantasy_add_player', `${season}: ${r.row.name} £${r.row.price}m`);
  faDone(req, res, r, r.ok && `Added ${r.row.name} to the ${season} player pool at £${r.row.price.toFixed(1)}m.`, 'player');
}));
router.post('/fantasy-league/admin/players/:id(\\d+)/delete', faAdmin, wrap((req, res) => {
  const db = req.app.locals.db; const FA = require('../lib/fantasy-admin'); const { season } = fantasyBase(req);
  const r = FA.removePlayer(db, season, Number(req.params.id));
  if (!r.ok) { req.flash('err', r.error); return res.redirect('/fantasy-league#fl-admin'); }
  q.audit(db, req.user.id, 'fantasy_remove_player', `${season}: ${r.row.name}`);
  req.flash('ok', `Removed ${r.row.name} from the player pool.`); res.redirect('/fantasy-league#fl-admin');
}));
router.post('/fantasy-league/admin/teams', faAdmin, wrap((req, res) => {
  const db = req.app.locals.db; const FA = require('../lib/fantasy-admin'); const { R, prices, season } = fantasyBase(req);
  const r = FA.addTeam(db, season, req.body, prices, R, req.user.id);
  if (r.ok) q.audit(db, req.user.id, 'fantasy_add_team', `${season}: "${r.row.team_name}" (${r.row.manager_name}) ${r.row.picks.map((p) => p.name).join(', ')}; captain ${r.row.captain}; £${r.row.cost}m`);
  faDone(req, res, r, r.ok && `Entered “${r.row.team_name}” for ${r.row.manager_name} (£${r.row.cost}m, captain ${r.row.captain}).`, 'team');
}));
router.post('/fantasy-league/admin/teams/:id(\\d+)/delete', faAdmin, wrap((req, res) => {
  const db = req.app.locals.db; const FA = require('../lib/fantasy-admin'); const { season } = fantasyBase(req);
  const r = FA.removeTeam(db, season, Number(req.params.id));
  if (!r.ok) { req.flash('err', r.error); return res.redirect('/fantasy-league#fl-admin'); }
  q.audit(db, req.user.id, 'fantasy_remove_team', `${season}: "${r.row.team_name}" (${r.row.manager_name})`);
  req.flash('ok', `Removed team “${r.row.team_name}”.`); res.redirect('/fantasy-league#fl-admin');
}));

router.get('/rules', wrap((req, res) => {
  const cfg = Soc.parseSocietyHcp(req.settings.society_hcp);
  const rules = String(req.settings.rules_text || '').split(/\r?\n/).map((s) => s.replace(/^[•\-*]\s*/, '').trim()).filter(Boolean);
  res.render('rules', { title: 'Rules', active: 'rules', rules, cfg, mode: req.settings.handicap_mode === 'whs' ? 'whs' : 'society' });
}));

module.exports = router;
