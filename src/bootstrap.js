'use strict';
/** First start: create the admin from ADMIN_EMAIL + ADMIN_PASSWORD. No shared/demo password is ever accepted. */
const bcrypt = require('bcryptjs'); const crypto = require('crypto');
const BANNED = ['password', 'changeme', 'admin123', 'demo-password', 'flamingo-demo-1'];
function ensureAdmin(db, env = process.env, log = console.log) {
  if (db.prepare('SELECT 1 FROM admins').get()) return null;
  let email = (env.ADMIN_EMAIL || '').toLowerCase().trim(); let pw = env.ADMIN_PASSWORD || '';
  if (env.NODE_ENV === 'production') {
    if (!email || pw.length < 12 || BANNED.includes(pw.toLowerCase())) throw new Error('First start in production needs ADMIN_EMAIL and a unique ADMIN_PASSWORD (12+ characters).');
  } else if (!email || !pw) {
    email = email || 'admin@example.test'; pw = crypto.randomBytes(9).toString('base64url');
    log(`Created local admin ${email} with one-time password: ${pw}  (set ADMIN_EMAIL/ADMIN_PASSWORD to choose your own)`);
  }
  db.prepare('INSERT INTO admins(email,password_hash) VALUES (?,?)').run(email, bcrypt.hashSync(pw, 10));
  return email;
}
module.exports = { ensureAdmin };
