'use strict';
/** Prize Money: public season page (/prize-money) and admin entry per event (/admin/prizes…, admins only; CSRF checked app-wide). */
const express = require('express');
const q = require('../lib/queries');
const PZ = require('../lib/prizes');
const { wrap, adminOnly } = require('../lib/guards');
const { setSetting } = require('../db');

const router = express.Router();
const cur = (req) => req.settings.currency || '£';
const asArr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

router.get('/prize-money', wrap((req, res) => {
  const db = req.app.locals.db;
  const year = PZ.pickYear(db, req.settings, req.query.year);
  res.render('prize-money', { title: `Prize Money ${year}`, active: 'prizes', year, years: PZ.years(db, req.settings), P: PZ.season(db, year), money: (p) => PZ.fmtMoney(p, cur(req)) });
}));

// ---- admin ----
const A = { adminLayout: true, active: 'admin', adminTab: 'prizes' };
router.get('/admin/prizes', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db;
  const year = PZ.pickYear(db, req.settings, req.query.year);
  res.render('admin/prizes', { ...A, title: 'Prize money', year, years: PZ.years(db, req.settings), events: PZ.seasonEvents(db, year), start: PZ.startSeason(req.settings), startSet: String(req.settings.prize_start_season || ''), money: (p) => PZ.fmtMoney(p, cur(req)), errors: {} });
}));

router.post('/admin/prizes/settings', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db; const v = String(req.body.prize_start_season || '').trim();
  if (v && !(/^\d{4}$/.test(v) && Number(v) >= 2000 && Number(v) <= 2100)) { req.flash('err', 'First prize money season must be a year like 2027 (or blank for this year).'); return res.redirect('/admin/prizes'); }
  setSetting(db, 'prize_start_season', v);
  q.audit(db, req.user.id, 'prize_settings', `first prize money season: ${v || 'this year'}`);
  req.flash('ok', `Prize money now starts with the ${PZ.startSeason({ prize_start_season: v })} season.`); res.redirect('/admin/prizes');
}));

function eventPage(req, res, eventId, extra = {}) {
  const db = req.app.locals.db;
  const ev = q.getEvent(db, eventId);
  if (!ev) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  const info = PZ.yearOfEvent(db, eventId);
  const lines = PZ.eventLines(db, eventId);
  const sug = PZ.suggestions(db, eventId);
  const places = lines.filter((l) => l.kind === 'place').map((l) => l.position);
  const nextPos = places.length ? Math.max(...places) + 1 : 1;
  const used = new Set(lines.map((l) => l.user_id).filter(Boolean));
  const members = db.prepare("SELECT id, name FROM users WHERE status='active' OR id IN (SELECT user_id FROM prize_lines WHERE event_id=? AND user_id IS NOT NULL) ORDER BY name").all(eventId);
  res.render('admin/prize-event', {
    ...A, title: `Prize money: ${ev.title}`, ev, year: info.year, locked: info.year < PZ.startSeason(req.settings), start: PZ.startSeason(req.settings),
    lines, sug, nextPos, members, used, money: (p) => PZ.fmtMoney(p, cur(req)), cur: cur(req),
    errors: {}, values: {}, form: null, editId: null, ...extra,
  });
}
router.get('/admin/prizes/events/:id(\\d+)', adminOnly, wrap((req, res) => eventPage(req, res, Number(req.params.id))));

const describe = (db, l, c) => `${l.kind === 'place' ? `${require('../lib/view-helpers').ordinal(l.position)}${l.tied ? ' (tie)' : ''} place` : l.kind === 'ntp' ? `nearest the pin${l.label ? ' ' + l.label : ''}` : l.label}: ${PZ.fmtMoney(l.amount_pence, c)} to ${l.winner_name}`;

router.post('/admin/prizes/events/:id(\\d+)/lines', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db; const id = Number(req.params.id); const b = req.body;
  const users = asArr(b.w_user); const names = asArr(b.w_name);
  const winners = b.kind === 'place' ? Array.from({ length: Math.max(users.length, names.length) }, (_, i) => ({ user_id: users[i] || '', winner_name: names[i] || '' })) : null;
  const r = PZ.addLine(db, req.settings, id, { ...b, winners }, req.user.id, cur(req));
  if (!r.ok) {
    if (r.status === 404) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
    res.status(r.status || 422); return eventPage(req, res, id, { errors: r.errors, values: b, form: b.kind });
  }
  for (const l of r.rows) q.audit(db, req.user.id, 'prize_add', `${r.ev.year} “${r.ev.title}” ${describe(db, { ...l, tied: r.rows.length > 1 }, cur(req))}`);
  req.flash('ok', r.rows.length > 1 ? `Added ${r.rows.length} tied winners.` : `Added ${PZ.fmtMoney(r.rows[0].amount_pence, cur(req))} to ${r.rows[0].winner_name}.`);
  res.redirect(`/admin/prizes/events/${id}#pz-lines`);
}));

router.post('/admin/prizes/lines/:id(\\d+)', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db; const id = Number(req.params.id);
  const r = PZ.editLine(db, req.settings, id, req.body, cur(req));
  if (!r.ok) {
    if (r.status === 404) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such prize.' });
    const old = r.old || PZ.getLine(db, id);
    res.status(r.status || 422); return eventPage(req, res, old.event_id, { errors: r.errors, values: req.body, form: 'edit', editId: id });
  }
  q.audit(db, req.user.id, 'prize_edit', `${r.ev.year} “${r.ev.title}” was ${describe(db, r.old, cur(req))}; now ${describe(db, r.row, cur(req))}`);
  req.flash('ok', 'Prize updated.'); res.redirect(`/admin/prizes/events/${r.old.event_id}#pz-lines`);
}));

router.post('/admin/prizes/lines/:id(\\d+)/delete', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db; const r = PZ.deleteLine(db, Number(req.params.id));
  if (!r.ok) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such prize.' });
  const ev = PZ.yearOfEvent(db, r.old.event_id);
  q.audit(db, req.user.id, 'prize_delete', `${ev ? ev.year + ' “' + ev.title + '” ' : ''}${describe(db, r.old, cur(req))}`);
  req.flash('ok', 'Prize removed.'); res.redirect(`/admin/prizes/events/${r.old.event_id}#pz-lines`);
}));

module.exports = router;
