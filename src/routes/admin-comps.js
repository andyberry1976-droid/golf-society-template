'use strict';
/** Admin: Birdie League & FedEx entry, matchplay brackets and multi-round tournaments (captain or admin). */
const express = require('express');
const { form } = require('../lib/validate');
const { wrap, staff } = require('../lib/guards');
const Q = require('../lib/queries');
const comps = require('../lib/comps');
const Soc = require('../lib/society');
const { recomputeAll, tournamentBoard } = require('../lib/engine');

const router = express.Router();
router.use(staff);
router.use(/^\/(?:events|tournaments|matchplay)(?:\/|$)/, (req, res, next) => { if (req.method === 'POST') require('../lib/newseason').resolve(req.app.locals.db, req.body, req.user && req.user.id); next(); });
const render = (res, view, data = {}) => res.render('admin/' + view, { adminLayout: true, active: 'admin', ...data });

// ---- Birdie League & FedEx --------------------------------------------------------
router.get('/comps', wrap((req, res) => {
  const db = req.app.locals.db;
  const season = Q.pickSeason(db, req.query.season);
  const events = season ? comps.seasonEvents(db, season.id) : [];
  const ev = events.find((e) => String(e.id) === String(req.query.event)) || events.filter((e) => e.status === 'completed').pop() || events[0] || null;
  const cur = { birdie: new Map(), fedex: new Map() };
  const played = new Set();
  if (ev) {
    for (const x of db.prepare('SELECT * FROM comp_scores WHERE event_id=?').all(ev.id)) cur[x.comp].set(x.user_id, x.value);
    for (const r of db.prepare('SELECT user_id FROM results WHERE event_id=?').all(ev.id)) played.add(r.user_id);
  }
  const members = Q.activeMembers(db).map((m) => ({ ...m, played: played.has(m.id) })).sort((a, b) => (b.played - a.played) || a.name.localeCompare(b.name));
  render(res, 'comps', { title: 'Birdies & FedEx', adminTab: 'comps', seasons: Q.seasons(db), season, events, ev, members, cur });
}));

router.post('/comps/:event(\\d+)', wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.event);
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(id);
  if (!ev) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  const body = req.body || {};
  const read = (prefix, max) => {
    const out = [];
    for (const m of Q.activeMembers(db)) {
      const raw = String(body[`${prefix}_${m.id}`] ?? '').trim();
      if (raw === '') continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > max) throw Object.assign(new Error(`${m.name}: ${prefix} must be a whole number 0–${max}`), { code: 'INVALID' });
      out.push([m.id, n]);
    }
    return out;
  };
  try {
    let fedex;
    if (body.fill_fedex) fedex = comps.fedexFromPositions(db, id);
    else fedex = read('fedex', 10);
    // birdies: separate birdie and eagle boxes, eagles count 2
    const b = new Map(read('birdies', 18)); const e = new Map(read('eagles', 9));
    const merged = [...new Set([...b.keys(), ...e.keys()])].map((uid) => [uid, Soc.birdieValue(b.get(uid) || 0, e.get(uid) || 0)]);
    comps.setCompScores(db, 'birdie', id, merged);
    comps.setCompScores(db, 'fedex', id, fedex);
    Q.audit(db, req.user.id, 'save_comps', `event ${id}`);
    req.flash('ok', body.fill_fedex ? `FedEx points filled from finishing positions (${fedex.length} players) and birdies saved.` : 'Birdie League and FedEx points saved.');
  } catch (err) {
    if (err.code !== 'INVALID') throw err;
    req.flash('err', err.message);
  }
  res.redirect(`/admin/comps?event=${id}`);
}));

// ---- Matchplay ---------------------------------------------------------------
router.get('/matchplay', wrap((req, res) => {
  const db = req.app.locals.db;
  render(res, 'matchplay-list', { title: 'Matchplay', adminTab: 'matchplay', list: db.prepare('SELECT * FROM mp_comps ORDER BY id DESC').all(), seasons: Q.seasons(db) });
}));
router.post('/matchplay', wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const name = f.str('name', { min: 3, max: 80, label: 'Name' });
  const size = f.oneOf('size', ['4', '8', '16', '32', '64'], { label: 'Draw size' });
  const seasonId = f.int('season_id', { min: 1, optional: true });
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/matchplay'); }
  const cat = db.prepare("SELECT id FROM honour_categories WHERE name='Matchplay'").get();
  const id = db.prepare('INSERT INTO mp_comps(season_id,name,size,notes,winner_cut,honour_category_id) VALUES (?,?,?,?,1,?)').run(seasonId, name, Number(size), 'Winner cut 1 shot.', cat ? cat.id : null).lastInsertRowid;
  req.flash('ok', 'Competition created — fill in the first-round draw.');
  res.redirect('/admin/matchplay/' + id);
}));
router.get('/matchplay/:id(\\d+)', wrap((req, res) => {
  const db = req.app.locals.db;
  const b = comps.bracket(db, Number(req.params.id));
  if (!b) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such competition.' });
  render(res, 'matchplay-edit', { title: b.comp.name, adminTab: 'matchplay', b, names: Q.activeMembers(db).map((m) => m.name) });
}));
router.post('/matchplay/:id(\\d+)/match', wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const f = form(req.body);
  const round = f.int('round', { min: 1, max: 7, label: 'Round' });
  const slot = f.int('slot', { min: 1, max: 64, label: 'Match' });
  const p1 = f.str('p1', { max: 80 }); const p2 = f.str('p2', { max: 80 });
  const w = f.oneOf('winner', ['', '1', '2'], { label: 'Winner' });
  const result = f.str('result', { max: 20 });
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect(`/admin/matchplay/${id}`); }
  if (w && !(w === '1' ? p1 : p2)) { req.flash('err', 'Pick a winner who is in the match.'); return res.redirect(`/admin/matchplay/${id}#m${round}-${slot}`); }
  comps.saveMatch(db, id, round, slot, { p1: p1 || null, p2: p2 || null, winner: w ? Number(w) : null, result: result || null });
  syncMatchplayHonour(db, id);
  Q.audit(db, req.user.id, 'save_match', `mp ${id} r${round} m${slot}`);
  req.flash('ok', 'Match saved' + (w ? ' — winner moved into the next round.' : '.'));
  res.redirect(`/admin/matchplay/${id}#m${round}-${slot}`);
}));
router.post('/matchplay/:id(\\d+)/settings', wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const f = form(req.body);
  const name = f.str('name', { min: 3, max: 80, label: 'Name' });
  const notes = f.str('notes', { max: 300 });
  const cut = f.num('winner_cut', { min: 0, max: 5, label: 'Winner cut' });
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect(`/admin/matchplay/${id}`); }
  db.prepare('UPDATE mp_comps SET name=?, notes=?, winner_cut=? WHERE id=?').run(name, notes || null, cut, id);
  req.flash('ok', 'Saved.');
  res.redirect(`/admin/matchplay/${id}`);
}));
/** When the final has a winner, record them on the roll of honour (once). */
function syncMatchplayHonour(db, compId) {
  const b = comps.bracket(db, compId);
  if (!b.comp.honour_category_id) return;
  const year = b.comp.season_id ? db.prepare('SELECT year FROM seasons WHERE id=?').get(b.comp.season_id).year : new Date().getFullYear();
  const detail = `${b.comp.name} (bracket)`;
  db.prepare("DELETE FROM honours WHERE category_id=? AND year=? AND detail=? AND source='manual'").run(b.comp.honour_category_id, year, detail);
  const fin = b.rounds[b.rounds.length - 1].matches[0];
  const wid = fin.winner ? fin[`p${fin.winner}_id`] : null;
  if (wid) db.prepare("INSERT INTO honours(category_id,year,user_id,detail,source) VALUES (?,?,?,?,'manual')").run(b.comp.honour_category_id, year, wid, detail);
}

// ---- Tournaments (Majors, Euro) -------------------------------------------------------------
router.get('/tournaments', wrap((req, res) => {
  const db = req.app.locals.db;
  const list = db.prepare('SELECT t.*, s.name AS season_name FROM tournaments t JOIN seasons s ON s.id=t.season_id ORDER BY s.year DESC, t.id').all()
    .map((t) => ({ ...t, board: tournamentBoard(db, t.id), events: comps.seasonEvents(db, t.season_id) }));
  render(res, 'tournaments', { title: 'Majors & Euro', adminTab: 'tournaments', list, seasons: Q.seasons(db), cats: db.prepare('SELECT * FROM honour_categories ORDER BY sort,name').all() });
}));
function tourFromForm(f) {
  return {
    name: f.str('name', { min: 3, max: 80, label: 'Name' }),
    kind: f.oneOf('kind', ['major', 'euro', 'other'], { label: 'Type' }),
    season_id: f.int('season_id', { min: 1, label: 'Season' }),
    winner_cut: f.num('winner_cut', { min: 0, max: 5, label: 'Winner cut' }),
    cut_applies: f.bool('cut_applies') ? 1 : 0,
    cut_note: f.str('cut_note', { max: 120 }) || null,
    honour_category_id: f.int('honour_category_id', { min: 1, optional: true }),
  };
}
router.post('/tournaments', wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body); const t = tourFromForm(f);
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/tournaments'); }
  db.prepare('INSERT INTO tournaments(season_id,name,kind,winner_cut,cut_applies,cut_note,honour_category_id) VALUES (@season_id,@name,@kind,@winner_cut,@cut_applies,@cut_note,@honour_category_id)').run(t);
  req.flash('ok', 'Tournament created. Now tick which events are its rounds.');
  res.redirect('/admin/tournaments');
}));
router.post('/tournaments/:id(\\d+)', wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const f = form(req.body); const t = tourFromForm(f);
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/tournaments'); }
  const rounds = [].concat(req.body.rounds || []).map(Number).filter(Number.isInteger);
  db.transaction(() => {
    db.prepare('UPDATE tournaments SET season_id=@season_id,name=@name,kind=@kind,winner_cut=@winner_cut,cut_applies=@cut_applies,cut_note=@cut_note,honour_category_id=@honour_category_id WHERE id=@id').run({ ...t, id });
    db.prepare('UPDATE events SET tournament_id=NULL, round_no=NULL WHERE tournament_id=?').run(id);
    const evs = rounds.length ? db.prepare(`SELECT id FROM events WHERE id IN (${rounds.map(() => '?').join(',')}) ORDER BY event_date, id`).all(...rounds) : [];
    evs.forEach((e, i) => db.prepare('UPDATE events SET tournament_id=?, round_no=? WHERE id=?').run(id, i + 1, e.id));
    recomputeAll(db);
  })();
  Q.audit(db, req.user.id, 'save_tournament', String(id));
  req.flash('ok', 'Tournament saved. Enter each round’s scores from the event’s results page.');
  res.redirect('/admin/tournaments');
}));

module.exports = router;
