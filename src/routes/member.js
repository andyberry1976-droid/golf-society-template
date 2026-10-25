'use strict';
const express = require('express');
const { form } = require('../lib/validate');
const { wrap, requireLogin, staff } = require('../lib/guards');
const users = require('../lib/users');
const rsvpLib = require('../lib/rsvp');
const Q = require('../lib/queries');

const router = express.Router();

// ---- RSVP ---------------------------------------------------------------------
router.post('/events/:id(\\d+)/rsvp', requireLogin, wrap((req, res) => {
  const db = req.app.locals.db;
  const e = Q.getEvent(db, Number(req.params.id));
  if (!e) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  const want = req.body.status === 'going' ? 'going' : req.body.status === 'not_going' ? 'not_going' : null;
  if (!want) { req.flash('err', 'Unknown RSVP option.'); return res.redirect('/events/' + e.id); }
  if (e.status !== 'scheduled' || e.event_date < Q.today()) {
    req.flash('err', e.status === 'cancelled' ? 'This event has been cancelled.' : 'RSVPs are closed for this event.');
    return res.redirect('/events/' + e.id);
  }
  const out = rsvpLib.setRsvp(db, e.id, req.user.id, want);
  if (want === 'not_going') req.flash('ok', "No problem — we've marked you as not going.");
  else if (out.status === 'going') req.flash('confetti', `You're in! See you at ${e.tee_time} on the tee. ⛳`);
  else req.flash('ok', "The event is full, so you're on the waitlist. We'll bump you in automatically if a place opens up.");
  res.redirect('/events/' + e.id);
}));

// Captain/admin: add or remove somebody's RSVP
router.post('/events/:id(\\d+)/rsvp-admin', staff, wrap((req, res) => {
  const db = req.app.locals.db;
  const e = Q.getEvent(db, Number(req.params.id));
  if (!e) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'No such event.' });
  const uid = Number(req.body.user_id);
  const u = db.prepare("SELECT id,name FROM users WHERE id=? AND status='active'").get(uid);
  if (!u) { req.flash('err', 'Pick a member.'); return res.redirect('/events/' + e.id); }
  const act = req.body.action;
  if (act === 'remove') { const o = rsvpLib.removeRsvp(db, e.id, uid); req.flash('ok', `${u.name} removed.` + (o.promoted.length ? ' A waitlisted member was promoted.' : '')); }
  else if (act === 'going' || act === 'not_going') { const o = rsvpLib.setRsvp(db, e.id, uid, act); req.flash('ok', `${u.name} is now: ${o.status.replace('_', ' ')}.`); }
  Q.audit(db, req.user.id, 'rsvp_admin', `${e.id}:${uid}:${act}`);
  res.redirect('/events/' + e.id);
}));

// ---- Account -------------------------------------------------------------------
router.get('/account', requireLogin, wrap((req, res) => {
  const db = req.app.locals.db;
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const notices = db.prepare('SELECT * FROM notices WHERE user_id=? ORDER BY id DESC LIMIT 20').all(me.id);
  db.prepare("UPDATE notices SET read_at=datetime('now') WHERE user_id=? AND read_at IS NULL").run(me.id);
  const mine = db.prepare(`SELECT r.status, r.queue_seq, e.id, e.title, e.event_date, e.end_date, e.tee_time FROM rsvps r JOIN events e ON e.id=r.event_id
    WHERE r.user_id=? AND e.status='scheduled' AND COALESCE(e.end_date,e.event_date)>=? AND r.status!='not_going' ORDER BY e.event_date`).all(me.id, Q.today());
  const season = Q.currentSeason(db);
  const mySubs = req.features.on.subs && season ? { season, row: require('../lib/subs').get(db, season.id, me.id) } : null;
  res.render('account', { title: 'My account', active: 'account', me, notices, mine, mySubs, values: me, errors: {} });
}));

router.post('/account', requireLogin, wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  const name = f.str('name', { min: 2, max: 80, label: 'Name' });
  const nickname = f.str('nickname', { max: 40 });
  const home = f.str('home_course', { max: 80 });
  const bio = f.str('bio', { max: 400 });
  if (!f.ok) {
    const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    return res.status(422).render('account', { title: 'My account', active: 'account', me, notices: [], mine: [], values: f.values, errors: f.errors });
  }
  db.prepare('UPDATE users SET name=?, nickname=?, home_course=?, bio=? WHERE id=?').run(name, nickname || null, home || null, bio || null, req.user.id);
  req.flash('ok', 'Profile saved.');
  res.redirect('/account');
}));

router.post('/account/password', requireLogin, wrap((req, res) => {
  const db = req.app.locals.db;
  const me = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  const f = form(req.body);
  const pw = f.password('new_password', { label: 'New password' });
  if (!users.checkPassword(String(req.body.current_password || ''), me.password_hash)) f.fail('current_password', 'Current password is wrong');
  if (pw && pw !== String(req.body.new_password2 || '')) f.fail('new_password2', 'The two passwords do not match');
  if (!f.ok) {
    return res.status(422).render('account', { title: 'My account', active: 'account', me, notices: [], mine: [], values: me, errors: f.errors, pwErrors: true });
  }
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(users.hashPassword(pw), me.id);
  // sign out other sessions? (single-table store keeps it simple: rotate this one)
  Q.audit(db, me.id, 'password_change', null);
  req.flash('ok', 'Password changed.');
  res.redirect('/account');
}));

module.exports = router;
