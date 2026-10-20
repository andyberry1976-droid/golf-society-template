'use strict';
const session = require('express-session');

/** Tiny express-session store that keeps sessions in the same SQLite file. */
class SqliteStore extends session.Store {
  constructor(db, { ttlMs = 14 * 24 * 3600 * 1000 } = {}) {
    super();
    this.db = db;
    this.ttlMs = ttlMs;
    this.sel = db.prepare('SELECT data, expires FROM sessions WHERE sid=?');
    this.up = db.prepare('INSERT INTO sessions(sid,data,expires) VALUES (?,?,?) ON CONFLICT(sid) DO UPDATE SET data=excluded.data, expires=excluded.expires');
    this.del = db.prepare('DELETE FROM sessions WHERE sid=?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires=? WHERE sid=?');
    this.purge = db.prepare('DELETE FROM sessions WHERE expires < ?');
    this.timer = setInterval(() => { try { this.purge.run(Date.now()); } catch { /* db closed */ } }, 3600 * 1000);
    this.timer.unref();
  }
  _exp(sess) {
    return sess && sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + this.ttlMs;
  }
  get(sid, cb) {
    try {
      const row = this.sel.get(sid);
      if (!row) return cb(null, null);
      if (row.expires < Date.now()) { this.del.run(sid); return cb(null, null); }
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try { this.up.run(sid, JSON.stringify(sess), this._exp(sess)); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try { this.del.run(sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try { this.touchStmt.run(this._exp(sess), sid); cb && cb(null); } catch (e) { cb && cb(e); }
  }
  close() { clearInterval(this.timer); }
}
module.exports = SqliteStore;
