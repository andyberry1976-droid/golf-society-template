'use strict';
const bcrypt = require('bcryptjs');
const { getSettings } = require('../db');
const { recomputeAll } = require('./engine');
const { today } = require('./queries');

const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '11', 10);
const hashPassword = (pw) => bcrypt.hashSync(pw, ROUNDS);
const checkPassword = (pw, hash) => !!hash && bcrypt.compareSync(pw, hash);
// A real hash to compare against when the email is unknown (keeps timing similar)
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', ROUNDS);

function createUser(db, { name, email, passwordHash = null, role = 'member', index = null, nickname = null, homeCourse = null, bio = null, joinedOn = null }) {
  const S = getSettings(db);
  const startIdx = index != null ? index : parseFloat(S.default_start_index) || 28;
  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO users(name,email,password_hash,role,nickname,home_course,bio,joined_on) VALUES (?,?,?,?,?,?,?,?)`)
      .run(name, email.toLowerCase(), passwordHash, role, nickname, homeCourse, bio, joinedOn || today());
    db.prepare(`INSERT INTO handicap_adjustments(user_id,effective_on,index_value,kind,note) VALUES (?,?,?,'initial',?)`)
      .run(info.lastInsertRowid, joinedOn || today(), startIdx, 'Starting handicap');
    return info.lastInsertRowid;
  })();
  recomputeAll(db);
  return id;
}

function emailTaken(db, email) {
  return !!db.prepare('SELECT 1 FROM users WHERE email=?').get(email.toLowerCase());
}

/** Approve a join request: creates the member account with the password the applicant chose. */
function approveRequest(db, requestId, adminId, { index = null, role = 'member' } = {}) {
  const r = db.prepare("SELECT * FROM join_requests WHERE id=? AND status='pending'").get(requestId);
  if (!r) throw Object.assign(new Error('Request not found or already decided'), { code: 'NOT_FOUND' });
  if (emailTaken(db, r.email)) throw Object.assign(new Error('That email already belongs to a member'), { code: 'DUPLICATE' });
  const id = createUser(db, { name: r.name, email: r.email, passwordHash: r.password_hash, role, index: index != null ? index : r.declared_index, homeCourse: r.home_course });
  db.prepare("UPDATE join_requests SET status='approved', user_id=?, decided_by=?, decided_at=datetime('now') WHERE id=?").run(id, adminId, requestId);
  return id;
}

function rejectRequest(db, requestId, adminId) {
  const info = db.prepare("UPDATE join_requests SET status='rejected', decided_by=?, decided_at=datetime('now') WHERE id=? AND status='pending'").run(adminId, requestId);
  return info.changes > 0;
}

// ---- Member logins (username + password set by an admin) ------------------------
// Usernames are stored lower-case and matched case-insensitively (unique NOCASE index).
const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,29}$/;
const normUsername = (s) => String(s == null ? '' : s).trim().toLowerCase();
function usernameError(u) {
  if (!u) return 'Enter a username';
  if (!USERNAME_RE.test(u)) return 'Username must be 3–30 characters: letters, numbers, dot, dash or underscore (start with a letter or number)';
  return null;
}
function usernameTaken(db, username, exceptId = null) {
  return !!db.prepare('SELECT 1 FROM users WHERE username=? COLLATE NOCASE AND id IS NOT ?').get(normUsername(username), exceptId);
}
function findByUsername(db, username) {
  const u = normUsername(username);
  return u ? db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE').get(u) || null : null;
}
/** Sign a user out everywhere (optionally keeping one session, e.g. the admin's own). */
function endSessions(db, userId, keepSid = null) {
  db.prepare('DELETE FROM sessions WHERE data LIKE ? AND sid IS NOT ?').run(`%"userId":${Number(userId)},%`, keepSid);
  db.prepare('DELETE FROM sessions WHERE data LIKE ? AND sid IS NOT ?').run(`%"userId":${Number(userId)}}%`, keepSid);
}

module.exports = { hashPassword, checkPassword, DUMMY_HASH, createUser, emailTaken, approveRequest, rejectRequest, USERNAME_RE, normUsername, usernameError, usernameTaken, findByUsername, endSessions };
