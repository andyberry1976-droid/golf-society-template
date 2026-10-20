'use strict';
const path = require('path');
const crypto = require('crypto');

const DEMO_PASSWORD = 'flamingo-demo-1';

function load(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const cfg = {
    production,
    port: parseInt(env.PORT || '3000', 10),
    dbPath: env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'society.db'),
    sessionSecret: env.SESSION_SECRET || '',
    trustProxy: env.TRUST_PROXY ? (isNaN(+env.TRUST_PROXY) ? env.TRUST_PROXY : +env.TRUST_PROXY) : false,
    adminEmail: env.ADMIN_EMAIL || '',
    adminName: env.ADMIN_NAME || 'Society Admin',
    adminPassword: env.ADMIN_PASSWORD || '',
    societyName: env.SOCIETY_NAME || 'Your Golf Society',
    secureCookies: production,
    loginLimit: { windowMs: 15 * 60 * 1000, limit: 10 },
    joinLimit: { windowMs: 60 * 60 * 1000, limit: 8 },
    demoPassword: DEMO_PASSWORD,
  };
  if (!cfg.sessionSecret) {
    if (production) throw new Error('SESSION_SECRET must be set in production (use e.g. `openssl rand -hex 32`).');
    cfg.sessionSecret = crypto.randomBytes(24).toString('hex'); // dev only: sessions reset on restart
  }
  return cfg;
}

module.exports = { load, DEMO_PASSWORD };
