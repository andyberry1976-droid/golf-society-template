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

/** Prize entry lives on each event's admin pages (edit + results entry), in the "Prize money" section. */
const BACK = { edit: 'edit', results: 'results' };
const backUrl = (id, back, anchor = 'prize-money') => `/admin/events/${id}/${BACK[back] || 'edit'}#${anchor}`;
/** Failed form: keep the input + errors in the session and send the admin back to the section they came from. */
function bounce(req, res, eventId, stash, anchor) {
  req.session.pzForm = { eventId, ...stash };
  req.flash('err', 'Prize not saved: ' + Object.values(stash.errors || {}).join(' · '));
  res.redirect(backUrl(eventId, req.body.back, anchor));
}
// the old stand-alone page now lives on the event
router.get('/admin/prizes/events/:id(\\d+)', adminOnly, (req, res) => res.redirect(backUrl(Number(req.params.id), req.query.back)));

const describe = (db, l, c) => `${l.kind === 'place' ? `${require('../lib/view-helpers').ordinal(l.position)}${l.tied ? ' (tie)' : ''} place` : l.kind === 'ntp' ? `nearest the pin${l.label ? ' ' + l.label : ''}` : l.label}: ${PZ.fmtMoney(l.amount_pence, c)} to ${l.winner_name}`;

router.post('/admin/prizes/events/:id(\\d+)/lines', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db; const id = Number(req.params.id); const b = req.body;
  const users = asArr(b.w_user); const names = asArr(b.w_name);
  const winners = b.kind === 'place' ? Array.from({ length: Math.max(users.length, names.length) }, (_, i) => ({ user_id: users[i] || '', winner_name: names[i] || '' })) : null;
  const r = PZ.addLine(db, req.settings, id, { ...b, winners }, req.user.id, cur(req));
  if (!r.ok) {
    if (r.status === 404) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
    const anchor = PZ.KINDS.includes(b.kind) ? 'pz-add-' + b.kind : 'prize-money';
    return bounce(req, res, id, { errors: r.errors, values: { ...b, _csrf: undefined }, form: b.kind }, anchor);
  }
  for (const l of r.rows) q.audit(db, req.user.id, 'prize_add', `${r.ev.year} “${r.ev.title}” ${describe(db, { ...l, tied: r.rows.length > 1 }, cur(req))}`);
  req.flash('ok', r.rows.length > 1 ? `Added ${r.rows.length} tied winners.` : `Added ${PZ.fmtMoney(r.rows[0].amount_pence, cur(req))} to ${r.rows[0].winner_name}.`);
  res.redirect(backUrl(id, b.back));
}));

router.post('/admin/prizes/lines/:id(\\d+)', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db; const id = Number(req.params.id);
  const r = PZ.editLine(db, req.settings, id, req.body, cur(req));
  if (!r.ok) {
    if (r.status === 404) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such prize.' });
    const old = r.old || PZ.getLine(db, id);
    return bounce(req, res, old.event_id, { errors: r.errors, values: { ...req.body, _csrf: undefined }, form: 'edit', editId: id }, 'pz-l' + id);
  }
  q.audit(db, req.user.id, 'prize_edit', `${r.ev.year} “${r.ev.title}” was ${describe(db, r.old, cur(req))}; now ${describe(db, r.row, cur(req))}`);
  req.flash('ok', 'Prize updated.'); res.redirect(backUrl(r.old.event_id, req.body.back));
}));

router.post('/admin/prizes/lines/:id(\\d+)/delete', adminOnly, wrap((req, res) => {
  const db = req.app.locals.db; const r = PZ.deleteLine(db, Number(req.params.id));
  if (!r.ok) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such prize.' });
  const ev = PZ.yearOfEvent(db, r.old.event_id);
  q.audit(db, req.user.id, 'prize_delete', `${ev ? ev.year + ' “' + ev.title + '” ' : ''}${describe(db, r.old, cur(req))}`);
  req.flash('ok', 'Prize removed.'); res.redirect(backUrl(r.old.event_id, req.body.back));
}));

/** For the admin event pages: the section data (admins only, feature on), using up any failed-form stash. */
router.section = (req, eventId) => {
  if (!req.user || req.user.role !== 'admin' || !req.features.on.prizes) return null;
  const stash = req.session && req.session.pzForm; if (stash) delete req.session.pzForm;
  const pz = PZ.adminSection(req.app.locals.db, req.settings, eventId, stash);
  if (pz) pz.money = (p) => PZ.fmtMoney(p, cur(req));
  return pz;
};
/** For the public event page. */
router.publicSection = (req, eventId) => {
  if (!req.features.on.prizes) return null;
  const pz = PZ.publicSection(req.app.locals.db, req.settings, eventId);
  if (pz) pz.money = (p) => PZ.fmtMoney(p, cur(req));
  return pz;
};
module.exports = router;
