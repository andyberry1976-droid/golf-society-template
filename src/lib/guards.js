'use strict';
const wrap = (fn) => (req, res, next) => { try { const r = fn(req, res, next); if (r && r.catch) r.catch(next); } catch (e) { next(e); } };

function requireLogin(req, res, next) {
  if (!req.user) {
    req.flash('info', 'Please log in to continue.');
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) { req.flash('info', 'Please log in to continue.'); return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)); }
  if (!roles.includes(req.user.role)) return res.status(403).render('error', { title: 'Not allowed', code: 403, message: "You don't have permission to do that. Ask an admin or the captain." });
  next();
};
const staff = requireRole('captain', 'admin');
const adminOnly = requireRole('admin');

/** Only allow same-site relative redirects. */
function safeNext(n, fallback = '/') {
  return typeof n === 'string' && /^\/(?![\/\\])/.test(n) ? n : fallback;
}

module.exports = { wrap, requireLogin, requireRole, staff, adminOnly, safeNext };
