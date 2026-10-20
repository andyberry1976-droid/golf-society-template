'use strict';
/** Admin (other societies): competition types built from presets, stored as JSON config. Shown as the Competitions tab when the 'engine' feature is on. */
const express = require('express');
const { wrap, adminOnly } = require('../lib/guards');
const { PRESETS, FORMATS, normalise } = require('../lib/scoring/presets');

const router = express.Router();
router.use('/competition-types', adminOnly);
const list = (db) => db.prepare('SELECT * FROM competition_types WHERE society_id=1 ORDER BY name').all();
const page = (res, db, edit, error = null) => res.render('admin/competition-types', { adminLayout: true, active: 'admin', title: 'Competition types', adminTab: 'comptypes', types: list(db), edit, presets: PRESETS, formats: FORMATS, error });

router.get('/competition-types', wrap((req, res) => {
  const db = req.app.locals.db;
  const row = req.query.edit ? db.prepare('SELECT * FROM competition_types WHERE id=? AND society_id=1').get(req.query.edit) : null;
  const preset = PRESETS[req.query.preset] ? req.query.preset : 'stableford';
  const edit = row ? { id: row.id, name: row.name, config: JSON.parse(row.config) } : { id: null, name: PRESETS[preset].label, config: normalise({ ...PRESETS[preset], preset }) };
  page(res, db, edit);
}));

router.post('/competition-types', wrap((req, res) => {
  const db = req.app.locals.db; const b = req.body;
  const name = String(b.name || '').trim().slice(0, 80);
  const cfg = normalise({
    preset: b.preset, format: b.format, team: (PRESETS[b.preset] || {}).team ?? null,
    allowance: { pct: b.allowance_pct, cap: b.cap ? { type: 'net_double_bogey' } : undefined },
    ranking: { tieBreak: b.countback ? 'countback' : 'none' },
    points: { mode: b.mode, positions: String(b.positions || '').split(/[\s,\/]+/).filter(Boolean), participation: b.participation,
      bonuses: [['played', b.bonus_played], ['birdies', b.bonus_birdie], ['last', b.bonus_last], [`stableford>=${parseInt(b.bonus_stb_at, 10) || 36}`, b.bonus_stb]].filter(([, v]) => parseInt(v, 10)).map(([when, pts]) => ({ when, pts })) },
  });
  if (!name) return page(res, db, { id: b.id || null, name, config: cfg }, 'Please give it a name');
  if (b.id) db.prepare("UPDATE competition_types SET name=?, config=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND society_id=1").run(name, JSON.stringify(cfg), b.id);
  else db.prepare('INSERT INTO competition_types(society_id,name,config) VALUES (1,?,?)').run(name, JSON.stringify(cfg));
  res.redirect('/admin/competition-types');
}));

module.exports = router;

// ---- generic events: link an event to a competition type, enter scores, compute; leagues; course holes ----
const EV = require('../lib/engine-events');
const Q = require('../lib/queries');
const int = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : Math.round(+v));
router.use(/^\/(engine|leagues)(\/|$)/, adminOnly);
router.get('/engine', wrap((req, res) => {
  const db = req.app.locals.db;
  res.render('admin/engine', { adminLayout: true, active: 'admin', adminTab: 'engine', title: 'Competitions',
    types: list(db), events: db.prepare(`SELECT e.*, t.name type_name FROM events e LEFT JOIN event_competitions ec ON ec.event_id=e.id LEFT JOIN competition_types t ON t.id=ec.competition_type_id ORDER BY e.event_date DESC`).all(),
    leagues: db.prepare('SELECT l.*, s.name season FROM leagues l LEFT JOIN seasons s ON s.id=l.season_id ORDER BY l.name').all(),
    seasons: db.prepare('SELECT * FROM seasons ORDER BY year DESC').all(), courses: db.prepare('SELECT * FROM courses ORDER BY name').all() });
}));
router.post('/engine/link', wrap((req, res) => {
  const db = req.app.locals.db; const ev = int(req.body.event_id); const t = int(req.body.competition_type_id);
  if (!ev) return res.redirect('/admin/engine');
  if (t) db.prepare('INSERT INTO event_competitions(society_id,event_id,competition_type_id) VALUES (1,?,?) ON CONFLICT(event_id) DO UPDATE SET competition_type_id=excluded.competition_type_id').run(ev, t);
  else db.prepare('DELETE FROM event_competitions WHERE event_id=?').run(ev);
  Q.audit(db, req.user.id, 'engine_link', `event ${ev} -> type ${t || 'none'}`);
  res.redirect(t ? `/admin/engine/events/${ev}` : '/admin/engine');
}));
router.post('/engine/courses/:id(\\d+)/holes', wrap((req, res) => {
  const db = req.app.locals.db;
  const pars = String(req.body.pars || '').split(/[\s,]+/).filter(Boolean).map(Number); const sis = String(req.body.sis || '').split(/[\s,]+/).filter(Boolean).map(Number);
  const ok = pars.length === 18 && sis.length === 18 && pars.every((p) => p >= 3 && p <= 6) && [...sis].sort((a, b) => a - b).every((v, i) => v === i + 1);
  db.prepare('UPDATE courses SET holes=? WHERE id=?').run(ok ? JSON.stringify(pars.map((p, i) => ({ par: p, si: sis[i] }))) : null, req.params.id);
  if (ok) db.prepare('UPDATE courses SET par=? WHERE id=?').run(pars.reduce((a, b) => a + b, 0), req.params.id);
  res.redirect('/admin/engine#courses');
}));
router.get('/engine/events/:id(\\d+)', wrap((req, res, next) => {
  const db = req.app.locals.db; const ev = db.prepare('SELECT * FROM events WHERE id=?').get(req.params.id); const type = ev && EV.typeFor(db, ev.id);
  if (!type) return next();
  const sc = new Map(db.prepare('SELECT * FROM engine_scores WHERE event_id=?').all(ev.id).map((s) => [s.user_id, s]));
  const members = db.prepare("SELECT id,name,handicap_index FROM users WHERE status='active' ORDER BY name").all();
  res.render('admin/engine-scores', { adminLayout: true, active: 'admin', adminTab: 'engine', title: 'Scores: ' + ev.title, ev, type, cfg: JSON.parse(type.config), members, sc, error: req.query.error || null });
}));
router.post('/engine/events/:id(\\d+)/scores', wrap((req, res) => {
  const db = req.app.locals.db; const ev = +req.params.id; const b = req.body; let bad = null;
  const up = db.prepare(`INSERT INTO engine_scores(society_id,event_id,user_id,team_no,hcp_index,holes,gross_total,stableford_total,birdies,position_in) VALUES (1,?,?,?,?,?,?,?,?,?)`);
  db.transaction(() => {
    db.prepare('DELETE FROM engine_scores WHERE event_id=?').run(ev);
    for (const m of db.prepare("SELECT id,name FROM users WHERE status='active'").all()) {
      const f = (k) => b[`${k}_${m.id}`]; const txt = String(f('holes') || '').trim(); let holes = null;
      if (txt) { const h = txt.split(/[\s,]+/).map((x) => (x === '-' || x === 'x' ? null : int(x))); if (h.length !== 18 || h.some((x) => x !== null && (x < 1 || x > 20))) { bad = `${m.name}: enter 18 hole scores (use - for no return)`; continue; } holes = JSON.stringify(h); }
      if (!holes && int(f('gross')) == null && int(f('stableford')) == null && int(f('position')) == null) continue;
      up.run(ev, m.id, int(f('team')), f('hcp') === '' || f('hcp') == null ? null : +f('hcp'), holes, int(f('gross')), int(f('stableford')), int(f('birdies')), int(f('position')));
    }
  })();
  if (bad) return res.redirect(`/admin/engine/events/${ev}?error=${encodeURIComponent(bad)}`);
  const n = EV.computeEvent(db, ev); Q.audit(db, req.user.id, 'engine_scores', `event ${ev}: ${n} results`);
  res.redirect(`/comp-results/${ev}`);
}));
router.post('/leagues', wrap((req, res) => {
  const db = req.app.locals.db; const b = req.body; const t = [].concat(b.types || []).map(Number).filter(Boolean);
  db.prepare('INSERT INTO leagues(society_id,season_id,name,config) VALUES (1,?,?,?)').run(int(b.season_id), String(b.name || 'League').slice(0, 80), JSON.stringify({ types: t.length ? t : null, events: null, bestN: int(b.bestN) || null }));
  res.redirect('/admin/engine#leagues');
}));
router.post('/leagues/:id(\\d+)/delete', wrap((req, res) => { req.app.locals.db.prepare('DELETE FROM leagues WHERE id=?').run(req.params.id); res.redirect('/admin/engine#leagues'); }));

// public pages (feature 'engine')
const pub = express.Router();
pub.get('/comp-results/:id(\\d+)', wrap((req, res, next) => {
  const db = req.app.locals.db; const ev = db.prepare('SELECT e.*, c.name course FROM events e LEFT JOIN courses c ON c.id=e.course_id WHERE e.id=?').get(req.params.id); const type = ev && EV.typeFor(db, ev.id);
  if (!type) return next();
  res.render('comp-results', { title: ev.title, active: 'results', ev, type, results: EV.results(db, ev.id) });
}));
pub.get('/leagues', wrap((req, res) => res.render('leagues', { title: 'Leagues', active: 'results', leagues: req.app.locals.db.prepare('SELECT * FROM leagues ORDER BY name').all(), L: null })));
pub.get('/leagues/:id(\\d+)', wrap((req, res, next) => { const L = EV.league(req.app.locals.db, req.params.id); if (!L) return next(); res.render('leagues', { title: L.league.name, active: 'results', leagues: [], L }); }));
module.exports.pub = pub;

