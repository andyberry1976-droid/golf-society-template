'use strict';
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { form } = require('../lib/validate');
const { wrap, staff, adminOnly } = require('../lib/guards');
const { setSetting, getSettings } = require('../db');
const users = require('../lib/users');
const rsvpLib = require('../lib/rsvp');
const Q = require('../lib/queries');
const { FORMATS, BASES, formatInfo } = require('../lib/formats');
const { saveResults } = require('../lib/results');
const { recomputeAll } = require('../lib/engine');
const P = require('../lib/points');
const stats = require('../lib/stats');
const standings = require('../lib/standings');

const router = express.Router();
const prizeSection = (req, id) => require('./prizes').section(req, id); // Prize money section on the event pages (admins only)
router.use(staff); // everything under /admin needs captain or admin; admin-only routes add adminOnly below
router.use(/^\/(?:events|tournaments|matchplay)(?:\/|$)/, (req, res, next) => { if (req.method === 'POST') require('../lib/newseason').resolve(req.app.locals.db, req.body, req.user && req.user.id); next(); });
// every Excel export, template and import is admin-only (captains and members get 403)
router.use(/^\/(?:events\/export\.xlsx|events\/import|events\/\d+\/scores\.xlsx|scores\.xlsx|scores\/import|subs\.xlsx)(?=\/|$)/, adminOnly);

const ICONS = ['s-trophy', 's-spoon', 's-star', 's-bow', 's-drive', 's-pin', 's-up', 's-moan', 's-lost', 's-sand', 's-ball', 's-heart', 's-flag', 's-spark', 's-tee'];
const TINTS = ['#ffe9c7', '#e6defa', '#fff3b8', '#fde1f2', '#d9fbe9'];
const A = { adminLayout: true };
const render = (res, view, data = {}) => res.render('admin/' + view, { ...A, active: 'admin', ...data });
const admins = (db) => db.prepare("SELECT COUNT(*) n FROM users WHERE role='admin' AND status='active'").get().n;

// ---- Dashboard ------------------------------------------------------------------
router.get('/', wrap((req, res) => {
  const db = req.app.locals.db;
  const season = Q.currentSeason(db);
  const c = (sql, ...a) => db.prepare(sql).get(...a).n;
  const awaiting = db.prepare(Q.EVENT_SELECT + " WHERE e.status='scheduled' AND COALESCE(e.end_date,e.event_date)<? ORDER BY e.event_date").all(Q.today()).map(Q.decorate);
  render(res, 'dashboard', {
    title: 'Admin dashboard', adminTab: 'dashboard', season,
    tiles: {
      members: c("SELECT COUNT(*) n FROM users WHERE status='active'"),
      pending: c("SELECT COUNT(*) n FROM join_requests WHERE status='pending'"),
      upcoming: c("SELECT COUNT(*) n FROM events WHERE status='scheduled' AND event_date>=?", Q.today()),
      events: season ? c("SELECT COUNT(*) n FROM events WHERE season_id=? AND status='completed'", season.id) : 0,
      rounds: c("SELECT COUNT(*) n FROM results r JOIN events e ON e.id=r.event_id WHERE e.status='completed'"),
      rsvps: c("SELECT COUNT(*) n FROM rsvps r JOIN events e ON e.id=r.event_id WHERE r.status='going' AND e.status='scheduled' AND e.event_date>=?", Q.today()),
      avgIdx: db.prepare("SELECT ROUND(AVG(handicap_index),1) v FROM users WHERE status='active' AND handicap_index IS NOT NULL").get().v,
    },
    requests: req.user.role === 'admin' ? db.prepare("SELECT * FROM join_requests WHERE status='pending' ORDER BY invite_ok DESC, id").all() : [],
    upcoming: Q.upcomingEvents(db, 6), awaiting,
    waitlisted: db.prepare(`SELECT e.id,e.title,e.event_date,COUNT(*) n FROM rsvps r JOIN events e ON e.id=r.event_id WHERE r.status='waitlist' AND e.status='scheduled' AND e.event_date>=? GROUP BY e.id`).all(Q.today()),
    audit: req.user.role === 'admin' ? db.prepare('SELECT a.*, u.name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 8').all() : [],
  });
}));

// ---- Join requests --------------------------------------------------------------
router.get('/requests', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  render(res, 'requests', {
    title: 'Join requests', adminTab: 'requests',
    pending: db.prepare("SELECT * FROM join_requests WHERE status='pending' ORDER BY invite_ok DESC, id").all(),
    decided: db.prepare("SELECT j.*, u.name AS by_name FROM join_requests j LEFT JOIN users u ON u.id=j.decided_by WHERE j.status!='pending' ORDER BY j.decided_at DESC LIMIT 15").all(),
  });
}));
router.post('/requests/:id(\\d+)/approve', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const idx = f.num('index', { min: -10, max: 54, optional: true, label: 'Starting handicap' });
  const role = f.oneOf('role', ['member', 'captain'], { label: 'Role' });
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/requests'); }
  try {
    const id = users.approveRequest(db, Number(req.params.id), req.user.id, { index: idx, role });
    Q.audit(db, req.user.id, 'approve_request', `user ${id}`);
    req.flash('ok', 'Approved — they can log in straight away with the password they chose.');
  } catch (e) { req.flash('err', e.message); }
  res.redirect('/admin/requests');
}));
router.post('/requests/:id(\\d+)/reject', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  req.flash(users.rejectRequest(db, Number(req.params.id), req.user.id) ? 'ok' : 'err', 'Request declined.');
  Q.audit(db, req.user.id, 'reject_request', req.params.id);
  res.redirect('/admin/requests');
}));

// ---- Members --------------------------------------------------------------------
router.get('/members', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  render(res, 'members', {
    title: 'Members', adminTab: 'members', values: {}, errors: {},
    members: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM results r WHERE r.user_id=u.id) AS rounds FROM users u ORDER BY u.status, u.name`).all(),
  });
}));
router.post('/members', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const name = f.str('name', { min: 2, max: 80, label: 'Name' });
  const email = f.email('email');
  const pw = f.password('password');
  const idx = f.num('index', { min: -10, max: 54, optional: true, label: 'Handicap' });
  const role = f.oneOf('role', ['member', 'captain', 'admin'], { label: 'Role' });
  if (f.ok && users.emailTaken(db, email)) f.fail('email', 'That email is already used');
  if (!f.ok) {
    return render(res.status(422), 'members', {
      title: 'Members', adminTab: 'members', values: f.values, errors: f.errors,
      members: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM results r WHERE r.user_id=u.id) AS rounds FROM users u ORDER BY u.status, u.name`).all(),
    });
  }
  const id = users.createUser(db, { name, email, passwordHash: users.hashPassword(pw), role, index: idx });
  Q.audit(db, req.user.id, 'create_member', `user ${id}`);
  req.flash('ok', `${name} added. Share the password with them privately and ask them to change it.`);
  res.redirect('/admin/members/' + id);
}));

function memberPage(req, res, extra = {}) {
  const db = req.app.locals.db;
  const m = db.prepare('SELECT * FROM users WHERE id=?').get(Number(req.params.id));
  if (!m) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such member.' });
  render(res, 'member', {
    title: m.name, adminTab: 'members', m, errors: {}, values: { ...m, date_of_birth: require('../lib/birthdays').adminLabel(m.date_of_birth) },
    history: db.prepare('SELECT * FROM handicap_history WHERE user_id=? ORDER BY seq DESC LIMIT 25').all(m.id),
    extras: db.prepare('SELECT * FROM extra_rounds WHERE user_id=? ORDER BY played_on DESC LIMIT 10').all(m.id),
    ...extra,
  });
}
router.get('/members/:id(\\d+)', adminOnly, wrap((req, res) => memberPage(req, res)));
router.post('/members/:id(\\d+)', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const m = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!m) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such member.' });
  const f = form(req.body);
  const name = f.str('name', { min: 2, max: 80, label: 'Name' });
  const email = f.email('email');
  const nick = f.str('nickname', { max: 40 });
  const home = f.str('home_course', { max: 80 });
  const role = f.oneOf('role', ['member', 'captain', 'admin'], { label: 'Role' });
  const status = f.oneOf('status', ['active', 'disabled'], { label: 'Status' });
  const ach = f.str('achievements', { max: 120, label: 'Achievements' });
  const lowest = f.num('lowest_index', { min: -10, max: 54, optional: true, label: 'Lowest ever handicap' });
  const subs = f.bool('subs_paid') ? 1 : 0;
  let dob = null; try { dob = require('../lib/birthdays').parse(req.body.date_of_birth); } catch (e) { f.fail('date_of_birth', e.message); }
  if (f.ok && email !== m.email && users.emailTaken(db, email)) f.fail('email', 'That email is already used');
  if (f.ok && m.role === 'admin' && (role !== 'admin' || status !== 'active') && admins(db) <= 1) f.fail('role', 'There must always be at least one active admin.');
  if (!f.ok) { res.status(422); return memberPage(req, res, { errors: f.errors, values: { ...m, ...f.values, date_of_birth: req.body.date_of_birth || '' } }); }
  db.prepare('UPDATE users SET name=?,email=?,nickname=?,home_course=?,role=?,status=?,achievements=?,lowest_index=?,subs_paid=?,date_of_birth=? WHERE id=?').run(name, email, nick || null, home || null, role, status, ach || null, lowest, subs, dob, id);
  { const sid = Subs.currentSeasonId(db); const cur = sid && Subs.get(db, sid, id);
    if (sid && (!cur || !!cur.paid !== !!subs)) Subs.set(db, sid, id, { ...(cur || {}), paid: subs, paid_on: subs ? ((cur && cur.paid_on) || Q.today()) : (cur && cur.paid_on) }, { actorId: req.user.id, audit: (a, d) => Q.audit(db, req.user.id, a, d), source: 'member form' }); }
  if (status === 'disabled') db.prepare("DELETE FROM sessions WHERE data LIKE ?").run(`%"userId":${id}%`);
  Q.audit(db, req.user.id, 'update_member', `user ${id} role=${role} status=${status}`);
  req.flash('ok', 'Member updated.');
  res.redirect('/admin/members/' + id);
}));
router.post('/members/:id(\\d+)/handicap', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const f = form(req.body);
  const idx = f.num('index', { min: -10, max: 54, label: 'Handicap index' });
  const note = f.str('note', { max: 120 });
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/members/' + id); }
  const prev = db.prepare('SELECT handicap_index FROM users WHERE id=?').get(id);
  if (!prev) { req.flash('err', 'Member not found'); return res.redirect('/admin/members'); }
  db.prepare(`INSERT INTO handicap_adjustments(user_id,effective_on,index_value,kind,note,created_by) VALUES (?,?,?,'manual',?,?)`).run(id, Q.today(), idx, note || 'Set by admin', req.user.id);
  recomputeAll(db);
  Q.audit(db, req.user.id, 'set_handicap', `user ${id}: ${prev && prev.handicap_index != null ? prev.handicap_index : '—'} -> ${idx}${note ? ` (${note})` : ''}`);
  const manual = require('../rules').handicap(req.settings.handicap_mode).manual;
  req.flash('ok', `Handicap set to ${idx.toFixed(1)}.${manual ? '' : ' It will keep adjusting automatically from the next result.'}`);
  res.redirect('/admin/members/' + id);
}));
router.post('/members/:id(\\d+)/password', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const f = form(req.body);
  const pw = f.password('password', { label: 'Temporary password' });
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/members/' + id); }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(users.hashPassword(pw), id);
  Q.audit(db, req.user.id, 'reset_password', `user ${id}`);
  req.flash('ok', 'Password reset. Tell them privately and ask them to change it in My account.');
  res.redirect('/admin/members/' + id);
}));
router.post('/members/:id(\\d+)/extra-round', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  if (require('../rules').handicap(req.settings.handicap_mode).manual) { req.flash('err', 'Handicaps are set by the admin on this site, so general-play rounds are not used.'); return res.redirect('/admin/members/' + id); }
  const f = form(req.body);
  const date = f.date('played_on', { label: 'Date' });
  const course = f.str('course_name', { min: 2, max: 80, label: 'Course' });
  const ags = f.int('ags', { min: 18, max: 200, label: 'Adjusted gross' });
  const rating = f.num('rating', { min: 50, max: 90, label: 'Course rating' });
  const slope = f.int('slope', { min: 55, max: 155, label: 'Slope' });
  const par = f.int('par', { min: 54, max: 80, label: 'Par' });
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/members/' + id); }
  db.prepare('INSERT INTO extra_rounds(user_id,played_on,course_name,ags,rating,slope,par,created_by) VALUES (?,?,?,?,?,?,?,?)').run(id, date, course, ags, rating, slope, par, req.user.id);
  recomputeAll(db);
  req.flash('ok', 'General-play round added to their handicap record.');
  res.redirect('/admin/members/' + id);
}));

// ---- Events ---------------------------------------------------------------------
const eventRows = (db, seasonId = null) => db.prepare(Q.EVENT_SELECT + ' WHERE (? IS NULL OR e.season_id=?) ORDER BY e.event_date DESC, e.id DESC LIMIT 500').all(seasonId, seasonId).map(Q.decorate);
const pickedSeason = (db, q) => (q && q !== 'all' ? db.prepare('SELECT * FROM seasons WHERE id=?').get(Number(q)) || null : null);
router.get('/events', wrap((req, res) => {
  const db = req.app.locals.db;
  const season = pickedSeason(db, req.query.season); // default: all seasons (as before)
  render(res, 'events', { title: 'Manage events', adminTab: 'events', events: eventRows(db, season && season.id), seasons: Q.seasons(db), season });
}));

// ---- Excel round-trip for events (same staff permission as editing events) ----------------------
const XL = require('../lib/events-xlsx');
const xlOpts = (req) => ({ on: req.features.on, hcpFixed: !!(require('../rules').HANDICAP[req.settings.handicap_mode] && require('../rules').HANDICAP[req.settings.handicap_mode].manual) });
router.get('/events/export.xlsx', wrap(async (req, res) => {
  const db = req.app.locals.db;
  const blank = req.query.blank === '1';
  const season = blank ? null : pickedSeason(db, req.query.season);
  const buf = await XL.exportWorkbook(db, { ...xlOpts(req), seasonId: season && season.id, blank, societyName: req.settings.society_name || 'Society' });
  const name = blank ? 'events-template.xlsx' : `events-${season ? season.name : 'all-seasons'}.xlsx`;
  if (!blank) Q.audit(db, req.user.id, 'events_export', `${season ? 'season ' + season.name : 'all seasons'}`);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`);
  res.send(buf);
}));
router.get('/events/import', wrap((req, res) => render(res, 'events-import', { title: 'Import events from Excel', adminTab: 'events', p: null, error: null })));
const previewPage = (res, p, extra = {}) => render(res, 'events-import', { title: 'Import events: preview', adminTab: 'events', p, error: null, ...extra });
router.post('/events/import', wrap(async (req, res) => {
  const db = req.app.locals.db;
  const file = req.files && req.files.file;
  if (!file || !file.data.length) return render(res.status(422), 'events-import', { title: 'Import events from Excel', adminTab: 'events', p: null, error: 'Choose an .xlsx file to upload.' });
  let sheet;
  try { sheet = await XL.readWorkbook(file.data, xlOpts(req)); } catch (e) {
    if (e.code !== 'BAD_FILE') throw e;
    return render(res.status(422), 'events-import', { title: 'Import events from Excel', adminTab: 'events', p: null, error: e.message });
  }
  const first = XL.plan(db, sheet);
  // unknown courses: ticked "create" by default in the preview; the admin can untick to see them as errors
  const p = XL.plan(db, sheet, { createCourses: first.unknownCourses });
  const token = require('crypto').randomBytes(12).toString('hex');
  req.session.evImport = { token, sheet, file: file.filename.slice(0, 120), createCourses: first.unknownCourses, at: Date.now() };
  previewPage(res, p, { token, file: file.filename, createCourses: first.unknownCourses, allUnknown: first.unknownCourses });
}));
// ---- Excel round-trip for players & scores (one row per player per event) -------------------------
const SX = require('../lib/scores-xlsx');
const sendXlsx = (res, name, buf) => { res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\w.-]/g, '_')}"`); res.send(buf); };
router.get('/events/:id(\\d+)/scores.xlsx', wrap(async (req, res) => {
  const db = req.app.locals.db;
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(Number(req.params.id));
  if (!ev) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  const blank = req.query.blank === '1';
  const buf = await SX.exportWorkbook(db, { eventId: ev.id, blank, on: req.features.on, societyName: req.settings.society_name || 'Society' });
  if (!blank) Q.audit(db, req.user.id, 'scores_export', `event ${ev.id} "${ev.title}"`);
  sendXlsx(res, `scores-${ev.event_date}-${ev.title.slice(0, 40)}${blank ? '-template' : ''}.xlsx`, buf);
}));
router.get('/scores.xlsx', wrap(async (req, res) => {
  const db = req.app.locals.db;
  const season = Q.pickSeason(db, req.query.season);
  if (!season) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such season.' });
  const blank = req.query.blank === '1';
  const buf = await SX.exportWorkbook(db, { seasonId: season.id, blank, on: req.features.on, societyName: req.settings.society_name || 'Society' });
  if (!blank) Q.audit(db, req.user.id, 'scores_export', `season ${season.name}`);
  sendXlsx(res, `scores-${season.name}${blank ? '-template' : ''}.xlsx`, buf);
}));
const scoresPage = (res, extra) => render(res, 'scores-import', { title: 'Import players & scores from Excel', adminTab: 'events', p: null, error: null, ev: null, ...extra });
router.get('/scores/import', wrap((req, res) => {
  const db = req.app.locals.db;
  scoresPage(res, { ev: req.query.event ? db.prepare('SELECT id,title FROM events WHERE id=?').get(Number(req.query.event)) || null : null, seasons: Q.seasons(db), cur: Q.currentSeason(db) });
}));
router.post('/scores/import', wrap(async (req, res) => {
  const db = req.app.locals.db;
  const file = req.files && req.files.file;
  const back = { seasons: Q.seasons(db), cur: Q.currentSeason(db) };
  if (!file || !file.data.length) return scoresPage(res.status(422), { ...back, error: 'Choose an .xlsx file to upload.' });
  let sheet;
  try { sheet = await SX.readWorkbook(file.data, { on: req.features.on }); } catch (e) { if (e.code !== 'BAD_FILE') throw e; return scoresPage(res.status(422), { ...back, error: e.message }); }
  const p = SX.plan(db, sheet);
  const token = require('crypto').randomBytes(12).toString('hex');
  req.session.scImport = { token, sheet, file: file.filename.slice(0, 120) };
  scoresPage(res, { title: 'Import players & scores: preview', p, token, file: file.filename });
}));
router.post('/scores/import/confirm', wrap((req, res) => {
  const db = req.app.locals.db;
  const st = req.session.scImport;
  if (!st || st.token !== req.body.token) { req.flash('err', 'That import preview has expired. Upload the file again.'); return res.redirect('/admin/scores/import'); }
  const p = SX.plan(db, st.sheet);
  if (p.counts.error) return scoresPage(res.status(422), { title: 'Import players & scores: preview', p, token: st.token, file: st.file, error: 'Nothing was saved: fix the rows with errors, then upload again.' });
  const r = SX.applyPlan(db, p, { actorId: req.user.id, audit: (a, d) => Q.audit(db, req.user.id, a, d) });
  Q.audit(db, req.user.id, 'scores_import', `"${st.file}": ${r.added} players added, ${r.results} results saved, ${r.comps} Birdie/FedEx entries, ${p.counts.unchanged} unchanged, events ${r.events.join(',') || '—'}`);
  delete req.session.scImport;
  req.flash('ok', `Scores import saved: ${r.added} player${r.added === 1 ? '' : 's'} added, ${r.results} result${r.results === 1 ? '' : 's'} saved, ${r.comps} Birdie/FedEx entr${r.comps === 1 ? 'y' : 'ies'}; ${p.counts.unchanged} unchanged. Standings recalculated.`);
  res.redirect(r.events.length === 1 ? `/admin/events/${r.events[0]}/results` : '/admin/events');
}));

router.post('/events/import/confirm', wrap((req, res) => {
  const db = req.app.locals.db;
  const st = req.session.evImport;
  if (!st || st.token !== req.body.token) { req.flash('err', 'That import preview has expired. Upload the file again.'); return res.redirect('/admin/events/import'); }
  const want = req.body.create_courses == null ? [] : [].concat(req.body.create_courses).map(String);
  const allUnknown = XL.plan(db, st.sheet).unknownCourses;
  const createCourses = allUnknown.filter((c) => want.some((w) => w.toLowerCase() === c.toLowerCase()));
  const p = XL.plan(db, st.sheet, { createCourses });
  if (req.body.action !== 'apply' || p.counts.error) {
    st.createCourses = createCourses;
    return previewPage(p.counts.error && req.body.action === 'apply' ? res.status(422) : res, p, { token: st.token, file: st.file, createCourses, allUnknown, error: req.body.action === 'apply' && p.counts.error ? 'Nothing was saved: fix the rows with errors (or create the unknown courses), then upload again.' : null });
  }
  const r = XL.applyPlan(db, p, { audit: (a, d) => Q.audit(db, req.user.id, a, d) });
  Q.audit(db, req.user.id, 'events_import', `"${st.file}": ${r.created.length} created, ${r.updated.length} updated, ${p.counts.unchanged} unchanged${r.coursesCreated.length ? `; new courses: ${r.coursesCreated.join(', ')}` : ''}`);
  delete req.session.evImport;
  req.flash('ok', `Import saved: ${r.created.length} new event${r.created.length === 1 ? '' : 's'}, ${r.updated.length} updated, ${p.counts.unchanged} unchanged${r.coursesCreated.length ? `; created course${r.coursesCreated.length === 1 ? '' : 's'} ${r.coursesCreated.join(', ')} (check par/rating/slope in Admin → Courses)` : ''}.`);
  res.redirect('/admin/events');
}));

function eventFormData(db, values = {}, errors = {}, ev = null) {
  const cs = Q.currentSeason(db);
  return {
    title: ev ? 'Edit event' : 'New event', adminTab: 'events', ev, errors,
    values: { season_id: cs && cs.id, format: 'stableford', scoring_basis: 'stableford', tee_time: '09:00', allowance_pct: 95, points_multiplier: 1, counts_handicap: 1, counts_oom: 1, counts_birdie: 1, counts_fedex: 1, cost: '', ...values },
    seasons: Q.seasons(db), courses: Q.listCourses(db), formats: FORMATS, bases: BASES,
    categories: db.prepare('SELECT * FROM honour_categories ORDER BY sort, name').all(),
  };
}
router.get('/events/new', wrap((req, res) => render(res, 'event-form', eventFormData(req.app.locals.db))));
router.get('/events/:id(\\d+)/edit', wrap((req, res) => {
  const db = req.app.locals.db;
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(Number(req.params.id));
  if (!ev) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  render(res, 'event-form', { ...eventFormData(db, { ...ev, end_date: ev.end_date || ev.event_date, cost: ev.cost_pence ? (ev.cost_pence / 100).toFixed(2).replace(/\.00$/, '') : '', capacity: ev.capacity ?? '', honour_category_id: ev.honour_category_id || '' }, {}, ev), field: Field.list(db, ev.id), candidates: Field.candidates(db, ev.id), pz: prizeSection(req, ev.id) });
}));

// ---- Event field: add / remove players (same staff permission as editing the event) ----------
const Field = require('../lib/field');
const fmtH = (h) => (h == null ? 'no handicap' : `hcp ${Number(h).toFixed(1)}`);
router.post('/events/:id(\\d+)/players', wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const ev = db.prepare('SELECT id, title FROM events WHERE id=?').get(id);
  if (!ev) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  const raw = req.body.user_ids ?? req.body.user_id;
  const ids = [...new Set((Array.isArray(raw) ? raw : [raw]).map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200);
  if (!ids.length) { req.flash('err', 'Pick at least one player to add.'); return res.redirect(`/admin/events/${id}/edit#players`); }
  let added;
  try { added = Field.add(db, id, ids, req.user.id); } catch (e) { if (e.code !== 'INVALID') throw e; req.flash('err', e.message); return res.redirect(`/admin/events/${id}/edit#players`); }
  for (const u of added) {
    const h = db.prepare('SELECT handicap_index FROM users WHERE id=?').get(u.id).handicap_index;
    Q.audit(db, req.user.id, 'event_add_player', `event ${id} "${ev.title}": + ${u.name} (user ${u.id}, ${fmtH(h)})`);
  }
  req.flash('ok', added.length ? `Added ${added.map((u) => u.name).join(', ')}.` : 'They were already in this event.');
  res.redirect(`/admin/events/${id}/edit#players`);
}));
router.post('/events/:id(\\d+)/players/:uid(\\d+)/remove', wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id); const uid = Number(req.params.uid);
  const ev = db.prepare('SELECT id, title FROM events WHERE id=?').get(id);
  const u = db.prepare('SELECT id, name FROM users WHERE id=?').get(uid);
  if (!ev || !u) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event or player.' });
  if (!Field.inField(db, id, uid)) { req.flash('info', `${u.name} wasn’t in this event.`); return res.redirect(`/admin/events/${id}/edit#players`); }
  const r = Field.remove(db, id, uid);
  const bits = [];
  if (r.result) bits.push(`result deleted (${['stableford_in', 'gross', 'position_in'].filter((k) => r.result[k] != null).map((k) => `${k.replace('_in', '')} ${r.result[k]}`).join(', ') || 'entered'})`);
  for (const c of r.comps) bits.push(`${c.comp} ${c.value} deleted`);
  if (r.rsvp) bits.push(`RSVP ${r.rsvp.status} removed`);
  Q.audit(db, req.user.id, 'event_remove_player', `event ${id} "${ev.title}": − ${u.name} (user ${uid})${bits.length ? '; ' + bits.join('; ') : ''}`);
  req.flash('ok', `Removed ${u.name}${r.result ? ' and their score' : ''}. Standings updated.`);
  res.redirect(`/admin/events/${id}/edit#players`);
}));

function parseEventForm(req) {
  const db = req.app.locals.db;
  const f = form(req.body);
  const v = {
    title: f.str('title', { min: 3, max: 100, label: 'Title' }),
    season_id: f.int('season_id', { min: 1, label: 'Season' }),
    course_id: f.int('course_id', { optional: true, min: 1, label: 'Course' }),
    event_date: f.date('event_date', { label: 'Date' }),
    end_date: f.date('end_date', { label: 'End date', optional: true }),
    tee_time: f.time('tee_time', { label: 'First tee time' }),
    format: f.oneOf('format', FORMATS.map((x) => x.key), { label: 'Format' }),
    scoring_basis: f.oneOf('scoring_basis', BASES.map((x) => x.key), { label: 'Scoring basis' }),
    cost: f.num('cost', { min: 0, max: 1000, optional: true, label: 'Cost' }),
    capacity: f.int('capacity', { min: 1, max: 500, optional: true, label: 'Capacity' }),
    notes: f.str('notes', { max: 600 }),
    counts_handicap: f.bool('counts_handicap') ? 1 : 0,
    counts_oom: f.bool('counts_oom') ? 1 : 0,
    counts_birdie: f.bool('counts_birdie') ? 1 : 0,
    counts_fedex: f.bool('counts_fedex') ? 1 : 0,
    points_multiplier: f.num('points_multiplier', { min: 0, max: 10, label: 'Points multiplier' }),
    allowance_pct: f.int('allowance_pct', { min: 50, max: 100, label: 'Handicap allowance %' }),
    honour_category_id: f.int('honour_category_id', { optional: true, min: 1, label: 'Roll of honour trophy' }),
    status: f.oneOf('status', ['scheduled', 'completed', 'cancelled'], { label: 'Status' }),
  };
  if (v.season_id && !db.prepare('SELECT 1 FROM seasons WHERE id=?').get(v.season_id)) f.fail('season_id', 'Pick a season');
  if (v.course_id && !db.prepare('SELECT 1 FROM courses WHERE id=?').get(v.course_id)) f.fail('course_id', 'Pick a course');
  // multi-day events: an end date or a number of days (blank / same day / 1 day = a one-day event, stored as NULL)
  const days = f.int('days', { optional: true, min: 1, max: 14, label: 'Number of days' });
  if (v.event_date && !v.end_date && days > 1) { const d = new Date(Date.parse(v.event_date + 'T12:00:00Z') + (days - 1) * 864e5); v.end_date = d.toISOString().slice(0, 10); }
  if (v.event_date && v.end_date) {
    if (v.end_date < v.event_date) f.fail('end_date', 'End date can’t be before the start date');
    else if ((Date.parse(v.end_date) - Date.parse(v.event_date)) / 864e5 > 13) f.fail('end_date', 'An event can last at most 14 days');
    if (v.end_date === v.event_date) v.end_date = null;
  }
  return { f, v };
}

router.post('/events', wrap((req, res) => {
  const db = req.app.locals.db;
  if (!req.body.status) req.body.status = 'scheduled';
  const { f, v } = parseEventForm(req);
  if (!f.ok) return render(res.status(422), 'event-form', eventFormData(db, f.values, f.errors));
  const info = db.prepare(`INSERT INTO events(season_id,title,course_id,event_date,end_date,tee_time,format,scoring_basis,cost_pence,capacity,notes,status,counts_handicap,counts_oom,points_multiplier,allowance_pct,honour_category_id,counts_birdie,counts_fedex)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(v.season_id, v.title, v.course_id, v.event_date, v.end_date || null, v.tee_time, v.format, v.scoring_basis, Math.round((v.cost || 0) * 100), v.capacity, v.notes || null,
    v.status === 'completed' ? 'scheduled' : v.status, v.counts_handicap, v.counts_oom, v.points_multiplier, v.allowance_pct, v.honour_category_id, v.counts_birdie, v.counts_fedex);
  Q.audit(db, req.user.id, 'create_event', `event ${info.lastInsertRowid}`);
  req.flash('ok', 'Event created. Members can RSVP now.');
  res.redirect('/events/' + info.lastInsertRowid);
}));
router.post('/events/:id(\\d+)', wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const ev = db.prepare('SELECT * FROM events WHERE id=?').get(id);
  if (!ev) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  const { f, v } = parseEventForm(req);
  if (f.ok && v.status === 'completed' && !db.prepare('SELECT 1 FROM results WHERE event_id=?').get(id)) f.fail('status', 'Enter results first — an event becomes completed when results are saved.');
  if (!f.ok) return render(res.status(422), 'event-form', { ...eventFormData(db, f.values, f.errors, ev), field: Field.list(db, ev.id), candidates: Field.candidates(db, ev.id), pz: prizeSection(req, ev.id) });
  db.transaction(() => {
    db.prepare(`UPDATE events SET season_id=?,title=?,course_id=?,event_date=?,end_date=?,tee_time=?,format=?,scoring_basis=?,cost_pence=?,notes=?,status=?,counts_handicap=?,counts_oom=?,points_multiplier=?,allowance_pct=?,honour_category_id=?,counts_birdie=?,counts_fedex=? WHERE id=?`)
      .run(v.season_id, v.title, v.course_id, v.event_date, v.end_date || null, v.tee_time, v.format, v.scoring_basis, Math.round((v.cost || 0) * 100), v.notes || null, v.status, v.counts_handicap, v.counts_oom, v.points_multiplier, v.allowance_pct, v.honour_category_id, v.counts_birdie, v.counts_fedex, id);
    rsvpLib.setCapacity(db, id, v.capacity); // promotes from the waitlist if capacity grew
    recomputeAll(db);
  })();
  Q.audit(db, req.user.id, 'update_event', `event ${id}`);
  req.flash('ok', 'Event saved.');
  res.redirect('/events/' + id);
}));
router.post('/events/:id(\\d+)/delete', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  if (db.prepare('SELECT 1 FROM results WHERE event_id=?').get(id)) { req.flash('err', 'This event has results — clear them first (or cancel the event instead).'); return res.redirect('/admin/events'); }
  db.prepare('DELETE FROM events WHERE id=?').run(id);
  Q.audit(db, req.user.id, 'delete_event', String(id));
  req.flash('ok', 'Event deleted.');
  res.redirect('/admin/events');
}));

// ---- Results entry ----------------------------------------------------------------
function resultsPage(req, res, extra = {}) {
  const db = req.app.locals.db;
  const e = Q.getEvent(db, Number(req.params.id));
  if (!e) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  const existing = new Map(db.prepare('SELECT * FROM results WHERE event_id=?').all(e.id).map((r) => [r.user_id, r]));
  const rs = new Map(db.prepare('SELECT user_id,status FROM rsvps WHERE event_id=?').all(e.id).map((r) => [r.user_id, r.status]));
  const members = Q.activeMembers(db).map((m) => ({ ...m, rsvp: rs.get(m.id) || null, res: existing.get(m.id) || null }));
  const fieldIds = new Set(require('../lib/field').list(db, e.id).map((p) => p.id));
  for (const m of members) m.inField = fieldIds.has(m.id);
  members.sort((a, b) => (b.res ? 1 : 0) - (a.res ? 1 : 0) || (b.inField - a.inField) || (b.rsvp === 'going') - (a.rsvp === 'going') || a.name.localeCompare(b.name));
  render(res, 'results', { title: 'Results · ' + e.title, adminTab: 'events', e, members, formError: null, submitted: null, pz: prizeSection(req, e.id), ...extra });
}
router.get('/events/:id(\\d+)/results', wrap((req, res) => resultsPage(req, res)));
router.post('/events/:id(\\d+)/results', wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const body = req.body.rows && typeof req.body.rows === 'object' ? req.body.rows : {};
  const rows = [];
  for (const [uid, r] of Object.entries(body)) {
    if (!/^u\d+$/.test(uid) || !r || typeof r !== 'object') continue;
    const has = ['gross', 'adjusted_gross', 'stableford', 'position'].some((k) => String(r[k] ?? '').trim() !== '');
    if (has) rows.push({ ...r, user_id: Number(uid.slice(1)) });
    else if (String(r.note || '').trim() || String(r.bonus || '').trim()) rows.push({ ...r, user_id: Number(uid.slice(1)) }); // surface the "needs a score" error
  }
  try {
    const { saved } = saveResults(db, id, rows);
    const hl = String(req.body.highlights || '').slice(0, 800).trim();
    db.prepare('UPDATE events SET highlights=? WHERE id=?').run(hl || null, id);
    Q.audit(db, req.user.id, 'save_results', `event ${id}: ${saved} players`);
    req.flash('confetti', saved ? `Results saved for ${saved} players. Handicaps, Order of Merit and honours updated.` : 'All results cleared.');
    res.redirect('/events/' + id);
  } catch (e) {
    if (e.code === 'INVALID') { res.status(422); return resultsPage(req, res, { formError: e.message + (e.userId ? ` (player #${e.userId})` : ''), submitted: body }); }
    throw e;
  }
}));

// ---- Seasons ----------------------------------------------------------------------
function schemeFromForm(f) {
  const posRaw = f.str('positions', { max: 300, label: 'Position points' });
  const positions = posRaw.split(/[\s,]+/).filter(Boolean).map(Number);
  if (!positions.length || positions.some((n) => !Number.isInteger(n) || n < 0 || n > 1000)) f.fail('positions', 'Use whole numbers separated by commas, e.g. 30, 24, 20, 17');
  const participation = f.int('participation', { min: 0, max: 100, label: 'Participation points' });
  const bestN = f.int('best_n', { min: 1, max: 60, optional: true, label: 'Best-N' });
  const mode = f.str('oom_mode', { max: 10 }) === 'score' ? 'score' : 'points';
  return { mode, positions, participation, bestN, countback: f.bool('countback') };
}
router.get('/seasons', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const S = req.settings;
  const list = Q.seasons(db).map((s) => ({ ...s, sch: P.parseScheme(s.scheme, P.parseScheme(S.oom_default_scheme)), custom: !!s.scheme, events: db.prepare('SELECT COUNT(*) n FROM events WHERE season_id=?').get(s.id).n }));
  const site = req.app.locals.site;
  const missingHistory = [];
  const can2025 = missingHistory.length > 0;
  const missingArchive = [];
  render(res, 'seasons', { title: 'Seasons & points', adminTab: 'seasons', seasons: list, errors: {}, values: {}, defaultScheme: P.parseScheme(S.oom_default_scheme), can2025, missingHistory, missingArchive });
}));
// ---- Membership subs (staff) ---------------------------------------------------------------------------------
const Subs = require('../lib/subs');
const subsList = (site) => { if (!site) return null; try { return require(require('path').join(site.dir, 'seed', 'subs-2026.js')); } catch (e) { return null; } };
router.get('/subs', wrap((req, res) => {
  const db = req.app.locals.db;
  const season = Q.pickSeason(db, req.query.season);
  if (!season) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No season.' });
  const all = Subs.list(db, season.id); const k = Subs.counts(all);
  const show = ['paid', 'unpaid'].includes(req.query.show) ? req.query.show : 'all';
  const q = String(req.query.q || '').trim().toLowerCase().slice(0, 40);
  const rows = all.filter((r) => (show === 'all' || (show === 'paid') === !!r.paid) && (!q || r.name.toLowerCase().includes(q) || (r.nickname || '').toLowerCase().includes(q)));
  const L = subsList(req.app.locals.site);
  render(res, 'subs', { title: 'Subs', adminTab: 'subs', season, seasons: Q.seasons(db), rows, k, show, q, list: L && L.SEASON === season.name ? L : null });
}));
router.post('/subs/:uid(\\d+)', wrap((req, res) => {
  const db = req.app.locals.db;
  const season = db.prepare('SELECT * FROM seasons WHERE id=?').get(Number(req.body.season_id));
  const u = db.prepare('SELECT id,name FROM users WHERE id=?').get(Number(req.params.uid));
  if (!season || !u) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such member or season.' });
  const cur = Subs.get(db, season.id, u.id) || {};
  const b = req.body;
  const v = b.toggle ? { paid: !cur.paid, paid_on: !cur.paid ? (cur.paid_on || Q.today()) : cur.paid_on, amount: cur.amount, note: cur.note }
    : { paid: b.paid === '1', paid_on: b.paid_on, amount: b.amount, note: b.note };
  if (!b.toggle && b.paid_on && !/^\d{4}-\d{2}-\d{2}$/.test(b.paid_on)) { req.flash('err', 'Date paid must be a date.'); return res.redirect(`/admin/subs?season=${season.id}#m${u.id}`); }
  if (!b.toggle && b.amount !== '' && b.amount != null && !(Number(b.amount) >= 0 && Number(b.amount) <= 10000)) { req.flash('err', 'Amount must be a number of pounds.'); return res.redirect(`/admin/subs?season=${season.id}#m${u.id}`); }
  const r = Subs.set(db, season.id, u.id, v, { actorId: req.user.id, audit: (a, d) => Q.audit(db, req.user.id, a, d) });
  req.flash('ok', r.changed ? `${u.name}: subs ${r.after.paid ? 'paid' : 'unpaid'} for ${season.name}.` : `${u.name}: nothing changed.`);
  const back = new URLSearchParams({ season: season.id }); if (b.show) back.set('show', b.show); if (b.q) back.set('q', b.q);
  res.redirect(`/admin/subs?${back}#m${u.id}`);
}));
router.get('/subs.xlsx', wrap(async (req, res) => {
  const db = req.app.locals.db;
  const season = Q.pickSeason(db, req.query.season);
  if (!season) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No season.' });
  const buf = await Subs.exportWorkbook(db, season.id, { societyName: req.settings.society_name });
  Q.audit(db, req.user.id, 'subs_export', `season ${season.name}`);
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="subs-${season.name}.xlsx"`);
  res.send(buf);
}));
router.post('/subs/apply-list', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const L = subsList(req.app.locals.site);
  const season = L && db.prepare('SELECT * FROM seasons WHERE name=?').get(L.SEASON);
  if (!L || !season) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No subs list for this society.' });
  const r = Subs.applyList(db, season.id, L.entries(), { actorId: req.user.id, audit: (a, d) => Q.audit(db, req.user.id, a, d), source: 'WhatsApp list' });
  Q.audit(db, req.user.id, 'subs_apply_list', `${season.name}: ${r.changed.length} changed, ${r.unchanged.length} unchanged, not found: ${r.missing.join(', ') || 'none'}`);
  req.flash(r.missing.length ? 'err' : 'ok', `WhatsApp list applied to ${season.name}: ${r.changed.length} updated, ${r.unchanged.length} already up to date${r.missing.length ? '; not found: ' + r.missing.join(', ') : ''}.`);
  res.redirect(`/admin/subs?season=${season.id}`);
}));

// ---- Saved copies in Postgres (read-only diagnostics) ----
router.get('/snapshots', adminOnly, wrap(async (req, res) => {
  const store = req.app.locals.store;
  if (!store) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'Postgres persistence is not on.' });
  const Database = require('better-sqlite3');
  const rows = [];
  for (const s of await store.list()) {
    const r = { id: s.id, at: s.created_at, bytes: s.bytes, reason: s.reason };
    if (req.query.scan === '1') {
      const full = await store.get(s.id); const d = new Database(full.data, { readonly: true });
      try {
        r.awardTypes = d.prepare('SELECT COUNT(*) n FROM award_types').get().n;
        r.awardGrants = d.prepare('SELECT COUNT(*) n FROM award_grants').get().n;
        r.extra = d.prepare("SELECT t.name, g.citation, u.name who, s.name season, g.created_at FROM award_grants g JOIN award_types t ON t.id=g.award_type_id JOIN users u ON u.id=g.user_id JOIN seasons s ON s.id=g.season_id").all();
        r.lastAudit = d.prepare('SELECT MAX(id) id, MAX(at) at FROM audit_log').get();
      } finally { d.close(); }
    }
    rows.push(r);
  }
  res.json({ writer: await store.getWriter(), ack: await store.getAck(), snapshots: rows });
}));

router.post('/seasons', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const name = f.str('name', { min: 2, max: 40, label: 'Name' });
  const year = f.int('year', { min: 1990, max: 2100, label: 'Year' });
  const start = f.date('start_date', { label: 'Start date' });
  const end = f.date('end_date', { label: 'End date' });
  if (f.ok && end < start) f.fail('end_date', 'End must be after start');
  if (f.ok && db.prepare('SELECT 1 FROM seasons WHERE name=?').get(name)) f.fail('name', 'A season with that name exists');
  if (!f.ok) {
    const S = req.settings;
    const list = Q.seasons(db).map((s) => ({ ...s, sch: P.parseScheme(s.scheme, P.parseScheme(S.oom_default_scheme)), custom: !!s.scheme, events: 0 }));
    return render(res.status(422), 'seasons', { title: 'Seasons & points', adminTab: 'seasons', seasons: list, errors: f.errors, values: f.values, defaultScheme: P.parseScheme(S.oom_default_scheme) });
  }
  db.prepare('INSERT INTO seasons(name,year,start_date,end_date) VALUES (?,?,?,?)').run(name, year, start, end);
  Q.audit(db, req.user.id, 'create_season', name);
  req.flash('ok', `Season “${name}” created. It uses the default points scheme until you customise it.`);
  res.redirect('/admin/seasons');
}));
router.post('/seasons/:id(\\d+)', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const f = form(req.body);
  const name = f.str('name', { min: 2, max: 40, label: 'Name' });
  const year = f.int('year', { min: 1990, max: 2100, label: 'Year' });
  const start = f.date('start_date', { label: 'Start date' });
  const end = f.date('end_date', { label: 'End date' });
  const scheme = schemeFromForm(f);
  if (f.ok && end < start) f.fail('end_date', 'End must be after start');
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/seasons'); }
  const useDefault = f.bool('use_default');
  db.prepare('UPDATE seasons SET name=?,year=?,start_date=?,end_date=?,scheme=? WHERE id=?').run(name, year, start, end, useDefault ? null : JSON.stringify(scheme), id);
  recomputeAll(db);
  Q.audit(db, req.user.id, 'update_season', `season ${id}`);
  req.flash('ok', 'Season saved and Order of Merit points recalculated.');
  res.redirect('/admin/seasons');
}));
router.post('/seasons/:id(\\d+)/status', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const id = Number(req.params.id);
  const status = req.body.status === 'closed' ? 'closed' : 'open';
  db.prepare('UPDATE seasons SET status=? WHERE id=?').run(status, id);
  recomputeAll(db);
  Q.audit(db, req.user.id, status === 'closed' ? 'close_season' : 'reopen_season', String(id));
  req.flash('ok', status === 'closed' ? 'Season closed — the Order of Merit winner has been added to the roll of honour.' : 'Season reopened.');
  res.redirect('/admin/seasons');
}));
router.post('/recalculate', adminOnly, wrap((req, res) => {
  recomputeAll(req.app.locals.db);
  req.flash('ok', 'Everything recalculated: handicaps, positions, points and honours.');
  res.redirect(req.get('referer') && req.get('referer').includes('/admin') ? '/admin/seasons' : '/admin');
}));

// ---- Awards -----------------------------------------------------------------------
router.get('/awards', wrap((req, res) => {
  const db = req.app.locals.db;
  const seasonsAll = Q.seasons(db);
  const sel = Q.pickSeason(db, req.query.season);
  render(res, 'awards', {
    title: 'Special awards', adminTab: 'awards', seasons: seasonsAll, sel, icons: ICONS, tints: TINTS,
    types: db.prepare('SELECT * FROM award_types ORDER BY sort, name').all(),
    grants: sel ? db.prepare(`SELECT g.*, t.name AS tname, t.icon, u.name AS uname FROM award_grants g JOIN award_types t ON t.id=g.award_type_id JOIN users u ON u.id=g.user_id WHERE g.season_id=? ORDER BY t.sort,t.name`).all(sel.id) : [],
    members: Q.activeMembers(db), suggestions: sel ? stats.awardSuggestions(db, sel.id) : {},
  });
}));
router.post('/awards/types', wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const name = f.str('name', { min: 2, max: 60, label: 'Name' });
  const emoji = String(req.body.emoji || '').trim();
  if (emoji && (emoji.length > 16 || !/\p{Extended_Pictographic}/u.test(emoji) || /[<>&"'\s]/.test(emoji))) f.fail('emoji', 'Use a single emoji, e.g. 🐌');
  const icon = emoji || f.oneOf('icon', ICONS, { label: 'Icon' });
  const tint = f.oneOf('tint', TINTS, { label: 'Colour' });
  const desc = f.str('description', { max: 200 });
  const rule = f.oneOf('rule', ['', 'wooden_spoon', 'sandbagger', 'consistency', 'most_improved'], { label: 'Suggestion rule' });
  if (f.ok && db.prepare('SELECT 1 FROM award_types WHERE name=?').get(name)) f.fail('name', 'That award already exists');
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/awards'); }
  db.prepare('INSERT INTO award_types(name,icon,tint,description,rule,sort) VALUES (?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM award_types))').run(name, icon, tint, desc || null, rule || null);
  req.flash('ok', `Award “${name}” created.`);
  res.redirect('/admin/awards');
}));
router.post('/awards/types/:id(\\d+)/delete', adminOnly, wrap((req, res) => {
  req.app.locals.db.prepare('DELETE FROM award_types WHERE id=?').run(Number(req.params.id));
  req.flash('ok', 'Award type deleted (and any grants of it).');
  res.redirect('/admin/awards');
}));
router.post('/awards/grants', wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const typeId = f.int('award_type_id', { min: 1, label: 'Award' });
  const seasonId = f.int('season_id', { min: 1, label: 'Season' });
  const userId = f.int('user_id', { min: 1, label: 'Member' });
  const citation = f.str('citation', { max: 240 });
  if (f.ok && !db.prepare('SELECT 1 FROM award_types WHERE id=?').get(typeId)) f.fail('award_type_id', 'Unknown award');
  if (f.ok && !db.prepare('SELECT 1 FROM users WHERE id=?').get(userId)) f.fail('user_id', 'Unknown member');
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/awards'); }
  db.prepare('INSERT OR REPLACE INTO award_grants(award_type_id,season_id,user_id,citation) VALUES (?,?,?,?)').run(typeId, seasonId, userId, citation || null);
  Q.audit(db, req.user.id, 'grant_award', `${typeId}/${seasonId}/${userId}`);
  req.flash('confetti', 'Award given! 🏆');
  res.redirect('/admin/awards?season=' + seasonId);
}));
router.post('/awards/grants/:id(\\d+)/delete', wrap((req, res) => {
  const db = req.app.locals.db;
  const g = db.prepare('SELECT season_id FROM award_grants WHERE id=?').get(Number(req.params.id));
  db.prepare('DELETE FROM award_grants WHERE id=?').run(Number(req.params.id));
  req.flash('ok', 'Award removed.');
  res.redirect('/admin/awards' + (g ? '?season=' + g.season_id : ''));
}));

// ---- Roll of honour (manual / historic entries + trophy categories) ----------------
router.get('/honours', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  render(res, 'honours', {
    title: 'Roll of honour', adminTab: 'honours',
    categories: db.prepare('SELECT * FROM honour_categories ORDER BY sort, name').all(),
    rows: db.prepare(`SELECT h.*, c.name AS cat, u.name AS uname, p.name AS pname FROM honours h JOIN honour_categories c ON c.id=h.category_id
      LEFT JOIN users u ON u.id=h.user_id LEFT JOIN users p ON p.id=h.partner_id ORDER BY h.year DESC, c.sort, c.name`).all(),
    members: Q.activeMembers(db),
  });
}));
router.post('/honours/categories', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const name = f.str('name', { min: 2, max: 60, label: 'Name' });
  const kind = f.oneOf('kind', ['event', 'oom', 'other'], { label: 'Kind' });
  if (f.ok && db.prepare('SELECT 1 FROM honour_categories WHERE name=?').get(name)) f.fail('name', 'Already exists');
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/honours'); }
  db.prepare('INSERT INTO honour_categories(name,kind,sort) VALUES (?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM honour_categories))').run(name, kind);
  req.flash('ok', 'Trophy added. Link events to it on the event form and winners appear automatically.');
  res.redirect('/admin/honours');
}));
router.post('/honours', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const cat = f.int('category_id', { min: 1, label: 'Trophy' });
  const year = f.int('year', { min: 1900, max: 2100, label: 'Year' });
  const uid = f.int('user_id', { optional: true, min: 1, label: 'Winner' });
  const pid = f.int('partner_id', { optional: true, min: 1, label: 'Partner' });
  const detail = f.str('detail', { max: 100 });
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/honours'); }
  db.prepare("INSERT INTO honours(category_id,year,user_id,partner_id,detail,source) VALUES (?,?,?,?,?,'manual')").run(cat, year, uid, pid, detail || null);
  req.flash('ok', 'Added to the roll of honour.');
  res.redirect('/admin/honours');
}));
router.post('/honours/:id(\\d+)/delete', adminOnly, wrap((req, res) => {
  req.app.locals.db.prepare("DELETE FROM honours WHERE id=? AND source='manual'").run(Number(req.params.id));
  req.flash('ok', 'Removed (automatic entries are managed from results & seasons).');
  res.redirect('/admin/honours');
}));

// ---- Courses ----------------------------------------------------------------------
router.get('/courses', wrap((req, res) => {
  render(res, 'courses', { title: 'Courses', adminTab: 'courses', courses: Q.listCourses(req.app.locals.db), errors: {}, values: {} });
}));
function courseFields(f) {
  return {
    name: f.str('name', { min: 2, max: 80, label: 'Course name' }), tee: f.str('tee', { min: 1, max: 30, label: 'Tee' }),
    par: f.int('par', { min: 54, max: 80, label: 'Par' }), rating: f.num('rating', { min: 50, max: 90, label: 'Course rating' }),
    slope: f.int('slope', { min: 55, max: 155, label: 'Slope' }), location: f.str('location', { max: 80 }),
  };
}
router.post('/courses', wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const c = courseFields(f);
  if (f.ok && db.prepare('SELECT 1 FROM courses WHERE name=? AND tee=?').get(c.name, c.tee)) f.fail('name', 'That course/tee already exists');
  if (!f.ok) return render(res.status(422), 'courses', { title: 'Courses', adminTab: 'courses', courses: Q.listCourses(db), errors: f.errors, values: f.values });
  db.prepare('INSERT INTO courses(name,tee,par,rating,slope,location) VALUES (?,?,?,?,?,?)').run(c.name, c.tee, c.par, c.rating, c.slope, c.location || null);
  req.flash('ok', 'Course added.');
  res.redirect('/admin/courses');
}));
router.post('/courses/:id(\\d+)', wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const c = courseFields(f);
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/courses'); }
  db.prepare('UPDATE courses SET name=?,tee=?,par=?,rating=?,slope=?,location=? WHERE id=?').run(c.name, c.tee, c.par, c.rating, c.slope, c.location || null, Number(req.params.id));
  recomputeAll(db);
  req.flash('ok', 'Course updated; handicaps recalculated.');
  res.redirect('/admin/courses');
}));

// ---- Fun records --------------------------------------------------------------------
router.get('/records', wrap((req, res) => {
  const db = req.app.locals.db;
  render(res, 'records', { title: 'Fun records', adminTab: 'records', rows: db.prepare('SELECT c.*, u.name AS uname FROM custom_records c LEFT JOIN users u ON u.id=c.holder_user_id ORDER BY sort,id').all(), members: Q.activeMembers(db), icons: ICONS, tints: TINTS });
}));
router.post('/records', wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const title = f.str('title', { min: 2, max: 60, label: 'Title' });
  const value = f.str('value', { min: 1, max: 30, label: 'Value' });
  const uid = f.int('holder_user_id', { optional: true, min: 1, label: 'Holder' });
  const text = f.str('holder_text', { max: 60 });
  const detail = f.str('detail', { max: 160 });
  const emoji = String(req.body.emoji || '').trim();
  if (emoji && (emoji.length > 16 || !/\p{Extended_Pictographic}/u.test(emoji) || /[<>&"'\s]/.test(emoji))) f.fail('emoji', 'Use a single emoji, e.g. 🐌');
  const icon = emoji || f.oneOf('icon', ICONS, { label: 'Icon' });
  const tint = f.oneOf('tint', TINTS, { label: 'Colour' });
  if (f.ok && !uid && !text) f.fail('holder_text', 'Pick a member or type a name');
  if (!f.ok) { req.flash('err', Object.values(f.errors)[0]); return res.redirect('/admin/records'); }
  db.prepare('INSERT INTO custom_records(title,value,holder_user_id,holder_text,detail,icon,tint,sort) VALUES (?,?,?,?,?,?,?,(SELECT COALESCE(MAX(sort),0)+1 FROM custom_records))').run(title, value, uid, text || null, detail || null, icon, tint);
  req.flash('ok', 'Record added.');
  res.redirect('/admin/records');
}));
router.post('/records/:id(\\d+)/delete', wrap((req, res) => {
  req.app.locals.db.prepare('DELETE FROM custom_records WHERE id=?').run(Number(req.params.id));
  req.flash('ok', 'Record removed.');
  res.redirect('/admin/records');
}));

// ---- Settings -----------------------------------------------------------------------
router.get('/settings', adminOnly, wrap((req, res) => {
  const sch = P.parseScheme(req.settings.oom_default_scheme);
  render(res, 'settings', { FEATURES: require('../lib/features').FEATURES, title: 'Society settings', adminTab: 'settings', errors: {}, values: { ...req.settings, positions: sch.positions.join(', '), participation: sch.participation, best_n: sch.bestN || '', oom_mode: sch.mode, countback: sch.countback ? '1' : '0', ...socValues(req.settings) } });
}));
function socValues(S) {
  const c = require('../lib/society').parseSocietyHcp(S.society_hcp);
  const v = { buffer_low: c.bufferLow, buffer_high: c.bufferHigh, under_add: c.underAdd, forty_plus: c.fortyPlus, forty_plus_cut: c.fortyPlusCut, monthly_win_cut: c.monthlyWinCut, monthly_min_field: c.monthlyMinField };
  c.categories.forEach((k, i) => { v[`cat${i + 1}_max`] = k.max; v[`cat${i + 1}_cut`] = k.cut; });
  return v;
}
router.post('/settings', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const text = {
    society_name: f.str('society_name', { min: 3, max: 80, label: 'Society name' }),
    short_name: f.str('short_name', { min: 2, max: 30, label: 'Short name' }),
    hero_title: f.str('hero_title', { min: 2, max: 60, label: 'Home page headline' }),
    hero_ribbon: f.str('hero_ribbon', { max: 40 }),
    est_text: f.str('est_text', { max: 80 }),
    tagline: f.str('tagline', { max: 300 }),
    footer_blurb: f.str('footer_blurb', { max: 300 }),
    join_blurb: f.str('join_blurb', { max: 300 }),
    currency: f.str('currency', { min: 1, max: 3, label: 'Currency symbol' }),
    contact_email: f.str('contact_email', { max: 120 }),
    invite_code: f.str('invite_code', { max: 40 }),
  };
  const allowance = f.int('default_allowance', { min: 50, max: 100, label: 'Default allowance %' });
  const maxIdx = f.num('max_index', { min: 10, max: 54, label: 'Max handicap index' });
  const startIdx = f.num('default_start_index', { min: 0, max: 54, label: 'Default starting index' });
  const scheme = schemeFromForm(f);
  const hm = f.str('handicap_mode', { max: 40 });
  const hlock = (req.app.locals.site.rules && req.app.locals.site.rules.handicap) || {};
  // a locked module (site config) can't be changed from the form
  const hmode = hlock.locked && hlock.module ? hlock.module : (require('../rules').HANDICAP[hm] ? hm : 'society');
  const rulesText = f.str('rules_text', { max: 4000 });
  const old = require('../lib/society').parseSocietyHcp(req.settings.society_hcp);
  const n = (k, d, o) => { const raw = String((req.body || {})[k] ?? '').trim(); if (raw === '') return d; const x = f.num(k, { ...o, label: k }); return x == null ? d : x; };
  const soc = {
    bufferLow: n('buffer_low', old.bufferLow, { min: 0, max: 60 }), bufferHigh: n('buffer_high', old.bufferHigh, { min: 0, max: 60 }),
    underAdd: n('under_add', old.underAdd, { min: 0, max: 5 }), fortyPlus: n('forty_plus', old.fortyPlus, { min: 0, max: 80 }), fortyPlusCut: n('forty_plus_cut', old.fortyPlusCut, { min: 0, max: 5 }),
    monthlyWinCut: n('monthly_win_cut', old.monthlyWinCut, { min: 0, max: 5 }), monthlyMinField: n('monthly_min_field', old.monthlyMinField, { min: 0, max: 100 }),
    categories: old.categories.map((c, i) => ({ cat: c.cat, max: n(`cat${i + 1}_max`, c.max, { min: 0, max: 99 }), cut: n(`cat${i + 1}_cut`, c.cut, { min: 0, max: 5 }) })),
  };
  if (!f.ok) {
    return render(res.status(422), 'settings', { FEATURES: require('../lib/features').FEATURES, title: 'Society settings', adminTab: 'settings', errors: f.errors, values: { ...req.settings, ...f.values } });
  }
  db.transaction(() => {
    for (const [k, v] of Object.entries(text)) setSetting(db, k, v);
    setSetting(db, 'default_allowance', allowance); setSetting(db, 'max_index', maxIdx); setSetting(db, 'default_start_index', startIdx);
    for (const k of ['invite_auto_approve', 'members_only', 'soft_cap', 'hard_cap']) setSetting(db, k, f.bool(k) ? '1' : '0');
    if (req.body && req.body.features_form) for (const k of require('../lib/features').KEYS) setSetting(db, `feature_${k}`, f.bool(`feature_${k}`) ? '1' : '0');
    setSetting(db, 'oom_default_scheme', JSON.stringify(scheme));
    if (!require('../rules').HANDICAP[hmode].manual || req.settings.handicap_mode === hmode) setSetting(db, 'handicap_mode', hmode);
    setSetting(db, 'society_hcp', JSON.stringify(soc));
    if (rulesText) setSetting(db, 'rules_text', rulesText);
    recomputeAll(db);
  })();
  if (require('../rules').HANDICAP[hmode].manual && req.settings.handicap_mode !== hmode) require('../lib/hcp-mode').setHandicapMode(db, hmode, { actorId: req.user.id });
  // audit who changed what (keys + old → new for switches and the rule module)
  const after = require('../db').getSettings(db);
  const changed = Object.keys(after).filter((k) => after[k] !== req.settings[k]);
  const short = (k) => (/^feature_|^handicap_mode$|_only$|_approve$|_cap$/.test(k) ? `${k}: ${req.settings[k] ?? '∅'} → ${after[k]}` : k);
  Q.audit(db, req.user.id, 'update_settings', changed.length ? changed.map(short).join('; ') : 'no changes');
  req.flash('ok', 'Settings saved.');
  res.redirect('/admin/settings');
}));

// ---- Backup -------------------------------------------------------------------------
router.get('/backup', adminOnly, wrap(async (req, res) => {
  const db = req.app.locals.db;
  const tmp = path.join(os.tmpdir(), `society-backup-${Date.now()}.db`);
  await db.backup(tmp);
  Q.audit(db, req.user.id, 'backup_download', null);
  res.download(tmp, `society-backup-${Q.today()}.db`, () => fs.unlink(tmp, () => {}));
}));

module.exports = router;
