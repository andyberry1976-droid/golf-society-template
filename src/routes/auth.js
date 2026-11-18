'use strict';
const express = require('express');
const { form } = require('../lib/validate');
const { wrap, safeNext } = require('../lib/guards');
const users = require('../lib/users');
const Q = require('../lib/queries');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Log in', active: 'login', values: {}, errors: {}, next: safeNext(req.query.next, '') });
});

router.post('/login', (req, res, next) => req.app.locals.limiters.login(req, res, next), wrap((req, res) => {
  const db = req.app.locals.db;
  const f = form(req.body);
  // one box takes an email (admin/captain/member email login) or a member username (admin-issued member login)
  const ident = f.str('email', { max: 254, label: 'Email or username' }).toLowerCase();
  const pw = String(req.body.password || '').slice(0, 200);
  const nextUrl = safeNext(req.body.next, '/');
  const byUsername = !!ident && !ident.includes('@');
  const u = !ident ? null : byUsername ? users.findByUsername(db, ident) : db.prepare('SELECT * FROM users WHERE email=?').get(ident);
  const pwOk = users.checkPassword(pw, u ? u.password_hash : users.DUMMY_HASH);
  // username logins are always plain member sessions (no captain/admin powers), and work even when sign-in is otherwise admin-only
  const ok = pwOk && u && u.status === 'active' && u.password_hash && (byUsername ? !!u.username : (!req.app.locals.adminLoginOnly || u.role === 'admin'));
  if (!ok) {
    const pending = !u && ident && !byUsername && db.prepare("SELECT 1 FROM join_requests WHERE email=? AND status='pending'").get(ident);
    return res.status(401).render('login', {
      title: 'Log in', active: 'login', values: { email: ident }, errors: {}, next: nextUrl,
      error: pending ? 'Your join request is still waiting for approval. An admin will be in touch soon.' : 'Email or password not recognised.',
    });
  }
  req.session.regenerate((err) => { // new session = new CSRF token (prevents fixation)
    if (err) throw err;
    req.session.userId = u.id;
    if (byUsername) req.session.memberLogin = true;
    Q.audit(db, u.id, byUsername ? 'member_login' : 'login', null);
    req.flash('ok', `Welcome back, ${u.nickname || u.name.split(' ')[0]}!`);
    res.redirect(nextUrl);
  });
}));

router.post('/logout', (req, res) => {
  req.session.destroy(() => { res.clearCookie('fs.sid'); res.redirect('/'); });
});

router.get('/join', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('join', { title: 'Join us', active: 'join', values: {}, errors: {} });
});

router.post('/join', (req, res, next) => req.app.locals.limiters.join(req, res, next), wrap((req, res) => {
  const db = req.app.locals.db;
  const S = req.settings;
  const f = form(req.body);
  const name = f.str('name', { min: 2, max: 80, label: 'Name' });
  const email = f.email('email');
  const pw = f.password('password');
  const pw2 = String(req.body.password2 || '');
  if (pw && pw !== pw2) f.fail('password2', 'The two passwords do not match');
  const hcp = f.num('handicap', { min: -10, max: parseFloat(S.max_index) || 54, optional: true, label: 'Handicap' });
  const home = f.str('home_course', { max: 80 });
  const message = f.str('message', { max: 500 });
  const code = f.str('invite_code', { max: 40 });
  if (f.ok && users.emailTaken(db, email)) f.fail('email', 'That email already has an account — try logging in.');
  if (f.ok && db.prepare("SELECT 1 FROM join_requests WHERE email=? AND status='pending'").get(email)) f.fail('email', 'You already have a request waiting for approval.');
  if (!f.ok) {
    const v = { ...f.values }; delete v.password;
    return res.status(422).render('join', { title: 'Join us', active: 'join', values: v, errors: f.errors });
  }
  const inviteOk = code && S.invite_code && code.toLowerCase() === S.invite_code.toLowerCase() ? 1 : 0;
  if (code && !inviteOk) {
    const v = { ...f.values }; delete v.password;
    return res.status(422).render('join', { title: 'Join us', active: 'join', values: v, errors: { invite_code: "That invite code isn't right. Leave it blank to apply without one." } });
  }
  const info = db.prepare(`INSERT INTO join_requests(name,email,password_hash,declared_index,home_course,message,invite_ok) VALUES (?,?,?,?,?,?,?)`)
    .run(name, email, users.hashPassword(pw), hcp, home || null, message || null, inviteOk);
  let autoApproved = false;
  if (inviteOk && S.invite_auto_approve === '1') {
    users.approveRequest(db, info.lastInsertRowid, null, { index: hcp });
    autoApproved = true;
  }
  Q.audit(db, null, 'join_request', email);
  res.render('join-done', { title: 'Thanks!', active: 'join', name, autoApproved });
}));

module.exports = router;
