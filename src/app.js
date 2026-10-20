'use strict';
const express = require('express'); const path = require('path'); const crypto = require('crypto'); const bcrypt = require('bcryptjs');
const { settings, setSetting } = require('./db'); const { PRESETS, FORMATS, normalise } = require('./lib/scoring/presets'); const { computeEvent, league } = require('./lib/compute');

const HEX = /^#[0-9a-f]{6}$/i;
function createApp(db) {
  const app = express();
  app.set('view engine', 'ejs'); app.set('views', path.join(__dirname, 'views'));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));
  app.use('/public', express.static(path.join(__dirname, '..', 'public')));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
    const sid = (req.headers.cookie || '').match(/(?:^|;\s*)sid=([a-f0-9]{64})/)?.[1];
    const s = sid && db.prepare('SELECT * FROM sessions WHERE id=? AND expires_at>?').get(sid, Date.now());
    req.session = s || null; res.locals.admin = !!s; res.locals.csrf = s ? s.csrf : ''; res.locals.site = settings(db);
    if (req.method === 'POST' && req.path !== '/login' && (!s || req.body._csrf !== s.csrf)) return res.status(403).send('Forbidden');
    next();
  });
  const admin = (req, res, next) => (req.session ? next() : res.redirect('/login'));
  const W = (fn) => (req, res, next) => { try { fn(req, res, next); } catch (e) { next(e); } };
  const types = () => db.prepare('SELECT * FROM competition_types WHERE society_id=1 ORDER BY name').all();
  const int = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : Math.round(+v));

  // ---- public ----
  app.get('/', W((req, res) => res.render('home', {
    upcoming: db.prepare("SELECT e.*, c.name course, t.name type FROM events e LEFT JOIN courses c ON c.id=e.course_id JOIN competition_types t ON t.id=e.competition_type_id WHERE e.status='scheduled' ORDER BY event_date").all(),
    done: db.prepare("SELECT e.*, t.name type FROM events e JOIN competition_types t ON t.id=e.competition_type_id WHERE e.status='completed' ORDER BY event_date DESC").all(),
    leagues: db.prepare('SELECT * FROM leagues ORDER BY name').all() })));
  app.get('/events/:id(\\d+)', W((req, res, next) => {
    const ev = db.prepare('SELECT e.*, c.name course, t.name type FROM events e LEFT JOIN courses c ON c.id=e.course_id JOIN competition_types t ON t.id=e.competition_type_id WHERE e.id=?').get(req.params.id);
    if (!ev) return next();
    res.render('event', { ev, results: db.prepare('SELECT r.*, m.name FROM results r JOIN members m ON m.id=r.member_id WHERE event_id=? ORDER BY position IS NULL, position, m.name').all(ev.id) });
  }));
  app.get('/leagues/:id(\\d+)', W((req, res, next) => { if (!db.prepare('SELECT 1 FROM leagues WHERE id=?').get(req.params.id)) return next(); res.render('league', league(db, req.params.id)); }));

  // ---- auth ----
  app.get('/login', (req, res) => res.render('login', { error: null }));
  app.post('/login', W((req, res) => {
    const a = db.prepare('SELECT * FROM admins WHERE email=?').get(String(req.body.email || '').toLowerCase().trim());
    if (!a || !bcrypt.compareSync(String(req.body.password || ''), a.password_hash)) return res.status(401).render('login', { error: 'Wrong email or password' });
    const id = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(id,admin_id,csrf,expires_at) VALUES (?,?,?,?)').run(id, a.id, crypto.randomBytes(16).toString('hex'), Date.now() + 7 * 864e5);
    res.set('Set-Cookie', `sid=${id}; HttpOnly; SameSite=Lax; Path=/${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`).redirect('/admin');
  }));
  app.post('/logout', (req, res) => { db.prepare('DELETE FROM sessions WHERE id=?').run(req.session.id); res.set('Set-Cookie', 'sid=; Max-Age=0; Path=/').redirect('/'); });

  // ---- admin ----
  const A = express.Router(); A.use(admin); app.use('/admin', A);
  const page = (res, data) => res.render('admin/index', {
    types: types(), presets: PRESETS, formats: FORMATS,
    members: db.prepare('SELECT * FROM members ORDER BY name').all(), courses: db.prepare('SELECT * FROM courses ORDER BY name').all(),
    events: db.prepare('SELECT e.*, t.name type FROM events e JOIN competition_types t ON t.id=e.competition_type_id ORDER BY event_date DESC').all(),
    leagues: db.prepare('SELECT * FROM leagues ORDER BY name').all(), edit: null, error: null, ...data });
  A.get('/', W((req, res) => {
    const row = req.query.type ? db.prepare('SELECT * FROM competition_types WHERE id=?').get(req.query.type) : null;
    const preset = PRESETS[req.query.preset] ? req.query.preset : 'stableford';
    page(res, { edit: row ? { id: row.id, name: row.name, config: JSON.parse(row.config) } : { id: null, name: PRESETS[preset].label, config: normalise({ ...PRESETS[preset], preset }) } });
  }));
  A.post('/settings', W((req, res) => {
    for (const k of ['name', 'tagline', 'logo_url']) if (req.body[k] != null) setSetting(db, k, String(req.body[k]).slice(0, 200));
    for (const k of ['primary', 'accent']) if (HEX.test(req.body[k] || '')) setSetting(db, k, req.body[k]);
    res.redirect('/admin');
  }));
  A.post('/members', W((req, res) => { const n = String(req.body.name || '').trim(); if (n) db.prepare('INSERT INTO members(name,handicap_index) VALUES (?,?)').run(n.slice(0, 80), +req.body.handicap_index || 28); res.redirect('/admin#members'); }));
  A.post('/courses', W((req, res) => {
    const pars = String(req.body.pars || '').split(/[\s,]+/).filter(Boolean).map(Number); const sis = String(req.body.sis || '').split(/[\s,]+/).filter(Boolean).map(Number);
    const holes = pars.length === 18 && sis.length === 18 ? JSON.stringify(pars.map((p, i) => ({ par: p, si: sis[i] }))) : null;
    db.prepare('INSERT INTO courses(name,par,rating,slope,holes) VALUES (?,?,?,?,?)').run(String(req.body.name || 'Course').slice(0, 80), holes ? pars.reduce((a, b) => a + b, 0) : int(req.body.par) || 72, +req.body.rating || 72, int(req.body.slope) || 113, holes);
    res.redirect('/admin#courses');
  }));
  A.post('/types', W((req, res) => {
    const b = req.body; const name = String(b.name || '').trim().slice(0, 80);
    const cfg = normalise({ preset: b.preset, format: b.format, team: (PRESETS[b.preset] || {}).team ?? null,
      allowance: { pct: b.allowance_pct, cap: b.cap ? { type: 'net_double_bogey' } : undefined }, ranking: { tieBreak: b.countback ? 'countback' : 'none' },
      points: { mode: b.mode, positions: String(b.positions || '').split(/[\s,\/]+/).filter(Boolean), participation: b.participation,
        bonuses: [['played', b.bonus_played], ['birdies', b.bonus_birdie], ['last', b.bonus_last], [`stableford>=${int(b.bonus_stb_at) || 36}`, b.bonus_stb]].filter(([, v]) => int(v)).map(([when, pts]) => ({ when, pts })) } });
    if (cfg.team && cfg.team.type === 'better_ball') cfg.allowance.difference = undefined;
    if (b.preset === 'matchplay') cfg.allowance.difference = true;
    if (!name) return page(res, { edit: { id: b.id || null, name, config: cfg }, error: 'Please give the competition a name' });
    if (b.id) db.prepare('UPDATE competition_types SET name=?, config=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(name, JSON.stringify(cfg), b.id);
    else db.prepare('INSERT INTO competition_types(name,config) VALUES (?,?)').run(name, JSON.stringify(cfg));
    res.redirect('/admin#types');
  }));
  A.post('/events', W((req, res) => {
    const b = req.body; if (!/^\d{4}-\d{2}-\d{2}$/.test(b.event_date || '') || !db.prepare('SELECT 1 FROM competition_types WHERE id=?').get(b.competition_type_id)) return page(res, { error: 'Event needs a date and a competition type' });
    const id = db.prepare('INSERT INTO events(title,event_date,course_id,competition_type_id,multiplier) VALUES (?,?,?,?,?)').run(String(b.title || 'Event').slice(0, 100), b.event_date, int(b.course_id), +b.competition_type_id, +b.multiplier || 1).lastInsertRowid;
    res.redirect(`/admin/events/${id}`);
  }));
  A.get('/events/:id(\\d+)', W((req, res, next) => {
    const ev = db.prepare('SELECT e.*, t.name type, t.config FROM events e JOIN competition_types t ON t.id=e.competition_type_id WHERE e.id=?').get(req.params.id); if (!ev) return next();
    const sc = new Map(db.prepare('SELECT * FROM scores WHERE event_id=?').all(ev.id).map((s) => [s.member_id, s]));
    res.render('admin/scores', { ev, cfg: JSON.parse(ev.config), members: db.prepare('SELECT * FROM members WHERE active=1 ORDER BY name').all(), sc, error: req.query.error || null });
  }));
  A.post('/events/:id(\\d+)/scores', W((req, res) => {
    const ev = req.params.id; const b = req.body; let bad = null;
    const up = db.prepare(`INSERT INTO scores(event_id,member_id,team_no,hcp_index,holes,gross_total,stableford_total,birdies,position_in) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(event_id,member_id) DO UPDATE SET team_no=excluded.team_no,hcp_index=excluded.hcp_index,holes=excluded.holes,gross_total=excluded.gross_total,stableford_total=excluded.stableford_total,birdies=excluded.birdies,position_in=excluded.position_in`);
    db.transaction(() => {
      db.prepare('DELETE FROM scores WHERE event_id=?').run(ev);
      for (const m of db.prepare('SELECT id,name FROM members WHERE active=1').all()) {
        const f = (k) => b[`${k}_${m.id}`]; const holesTxt = String(f('holes') || '').trim();
        let holes = null;
        if (holesTxt) { const h = holesTxt.split(/[\s,]+/).map((x) => (x === '-' || x === 'x' ? null : int(x))); if (h.length !== 18 || h.some((x) => x !== null && (x < 1 || x > 20))) { bad = `${m.name}: enter 18 hole scores (use - for no return)`; continue; } holes = JSON.stringify(h); }
        if (!holes && int(f('gross')) == null && int(f('stableford')) == null && int(f('position')) == null) continue;
        up.run(ev, m.id, int(f('team')), f('hcp') === '' || f('hcp') == null ? null : +f('hcp'), holes, int(f('gross')), int(f('stableford')), int(f('birdies')), int(f('position')));
      }
    })();
    if (bad) return res.redirect(`/admin/events/${ev}?error=${encodeURIComponent(bad)}`);
    computeEvent(db, ev); res.redirect(`/events/${ev}`);
  }));
  A.post('/leagues', W((req, res) => {
    const b = req.body; const t = [].concat(b.types || []).map(Number).filter(Boolean);
    db.prepare('INSERT INTO leagues(name,config) VALUES (?,?)').run(String(b.name || 'League').slice(0, 80), JSON.stringify({ types: t.length ? t : null, events: null, from: b.from || null, to: b.to || null, bestN: int(b.bestN) || null }));
    res.redirect('/admin#leagues');
  }));
  app.use((req, res) => res.status(404).render('message', { title: 'Not found', text: 'That page does not exist.' }));
  app.use((err, req, res, _n) => { console.error(err); res.status(500).render('message', { title: 'Something went wrong', text: 'Please try again.' }); });
  return app;
}
module.exports = { createApp };
