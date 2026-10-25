'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { getSettings } = require('./db');
const SqliteStore = require('./lib/session-store');
const helpers = require('./lib/view-helpers');
const q = require('./lib/queries');

function createApp({ db, config }) {
  const app = express();
  app.locals.db = db;
  app.locals.config = config;
  app.locals.fence = require('./lib/handover').makeFence();
  app.set('trust proxy', config.trustProxy);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'], fontSrc: ["'self'"], connectSrc: ["'self'"], formAction: ["'self'"],
        frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"],
        ...(config.production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: config.production,
    crossOriginEmbedderPolicy: false,
  }));

  app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: config.production ? '7d' : 0 }));
  // this society's own assets (logo …) from sites/<slug>/, never its config or seed data
  const site = config.site || require('./site').load();
  app.locals.site = site;
  app.get(/^\/site\/([a-z0-9._-]+\.(?:svg|png|jpe?g|webp|ico))$/i, (req, res, next) => {
    const file = path.join(site.dir, path.basename(req.params[0]));
    if (!require('fs').existsSync(file)) return next();
    res.set('Cache-Control', config.production ? 'public, max-age=86400' : 'no-cache');
    res.sendFile(file);
  });
  const themeCss = require('./site').themeCss(site);
  const logoUrl = site.branding && site.branding.logo ? '/site/' + path.basename(site.branding.logo) : null;
  const logoWordmark = !!(site.branding && site.branding.logo_wordmark && logoUrl);
  // site.config auth.admin_only: only admins can sign in (no member/captain logins, no join); data is untouched
  const adminLoginOnly = config.adminLoginOnly != null ? !!config.adminLoginOnly : !!(site.auth && site.auth.admin_only);
  app.locals.adminLoginOnly = adminLoginOnly;
  const themeColor = (site.branding && site.branding.theme_color) || '#064e3b';
  // file uploads (Excel imports) are multipart: parsed here so the CSRF check below sees their _csrf field
  app.use(['/admin/events/import', '/admin/scores/import'], require('./lib/multipart').upload({ limit: '5mb' }));
  app.use(require('./lib/handover').fenceMiddleware(app.locals.fence)); // refuses writes while handing over to a new instance
  app.use(express.urlencoded({ extended: true, limit: '300kb', parameterLimit: 6000 }));

  const store = new SqliteStore(db);
  app.locals.sessionStore = store;
  app.use(session({
    name: 'fs.sid',
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', secure: config.secureCookies ? 'auto' : false, maxAge: 14 * 24 * 3600 * 1000 },
  }));

  // ---- per-request context -------------------------------------------------
  app.use((req, res, next) => {
    const S = getSettings(db);
    req.settings = S;
    let user = null;
    if (req.session && req.session.userId) {
      user = db.prepare('SELECT id,name,nickname,email,role,status,handicap_index FROM users WHERE id=?').get(req.session.userId);
      if (!user || user.status !== 'active' || (adminLoginOnly && user.role !== 'admin')) { user = null; delete req.session.userId; }
    }
    req.user = user;
    req.flash = (type, msg) => { req.session.flash = req.session.flash || []; req.session.flash.push({ type, msg }); };
    const flash = req.session && req.session.flash ? req.session.flash : [];
    if (flash.length) delete req.session.flash;
    let F = require('./lib/features').fromSettings(S);
    if (adminLoginOnly) { const base = F; const isJoin = (p) => /^\/(join|admin\/requests)(\/|$)/.test(String(p).split(/[?#]/)[0]); F = { on: { ...base.on, join: false }, blocked: (p) => isJoin(p) || base.blocked(p), link: (h) => !isJoin(h) && base.link(h) }; }
    req.features = F;
    Object.assign(res.locals, helpers, {
      reqPath: req.path,
      S, user, F, flash, adminLoginOnly, h: helpers, themeCss, logoUrl, logoWordmark, themeColor, handicapModules: require('./rules').list().handicap,
      hcpFixed: !!(require('./rules').HANDICAP[S.handicap_mode] && require('./rules').HANDICAP[S.handicap_mode].manual),
      hcpLocked: !!(site.rules && site.rules.handicap && site.rules.handicap.locked),
      cur: S.currency || '£',
      path: req.path,
      title: null,
      active: '',
      csrf: () => { if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex'); return req.session.csrf; },
      isStaff: !!user && (user.role === 'admin' || user.role === 'captain'),
      isAdmin: !!user && user.role === 'admin',
      unread: user ? db.prepare('SELECT COUNT(*) n FROM notices WHERE user_id=? AND read_at IS NULL').get(user.id).n : 0,
      pendingCount: user && user.role === 'admin' ? db.prepare("SELECT COUNT(*) n FROM join_requests WHERE status='pending'").get().n : 0,
      today: q.today(),
    });
    next();
  });

  // ---- CSRF (synchroniser token kept in the session) -------------------------
  app.use((req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const sent = String((req.body && req.body._csrf) || '');
    const want = (req.session && req.session.csrf) || '';
    const ok = sent.length === want.length && want.length > 0 && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(want));
    if (!ok) return res.status(403).render('error', { title: 'Session expired', code: 403, message: 'Your form session expired or was invalid. Please go back, refresh the page and try again.' });
    next();
  });

  // switched-off modules: 404 (data untouched)
  app.use((req, res, next) => {
    if (req.features.blocked(req.path)) return res.status(404).render('error', { title: 'Not found', code: 404, message: 'That part of the site is switched off.' });
    next();
  });

  // members-only mode
  app.use((req, res, next) => {
    if (req.settings.members_only === '1' && !req.user && req.method === 'GET') {
      const open = req.path === '/' || req.path === '/login' || req.path.startsWith('/join');
      if (!open) { req.flash('info', 'This society site is for members only. Please log in.'); return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)); }
    }
    next();
  });

  const limiter = (opts, what) => rateLimit({
    windowMs: opts.windowMs, limit: opts.limit, standardHeaders: 'draft-7', legacyHeaders: false,
    skipSuccessfulRequests: what === 'login',
    handler: (req, res) => res.status(429).render('error', { title: 'Slow down', code: 429, message: 'Too many attempts. Please wait a few minutes and try again.' }),
  });
  app.locals.limiters = { login: limiter(config.loginLimit, 'login'), join: limiter(config.joinLimit, 'join') };

  app.use(require('./routes/public'));
  app.use(require('./routes/comps'));
  app.use(require('./routes/prizes'));
  app.use(require('./routes/auth'));
  app.use(require('./routes/member'));
  app.use('/admin', require('./routes/admin-comps'));
  app.use('/admin', require('./routes/admin-engine'));
  app.use(require('./routes/admin-engine').pub);
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => res.status(404).render('error', { title: 'Not found', code: 404, message: "That hole doesn't exist. Try the menu." }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (!config.production || process.env.LOG_ERRORS) console.error(err);
    else console.error(String(err && err.stack ? err.stack.split('\n')[0] : err));
    if (res.headersSent) return;
    res.status(500).render('error', { title: 'Oops', code: 500, message: 'Something went wrong on our side. Please try again.' });
  });
  return app;
}

module.exports = { createApp };
