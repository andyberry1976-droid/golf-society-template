'use strict';
/** RSVP, capacity & waitlist logic. All functions run in a transaction and return what changed. */

function counts(db, eventId) {
  const r = db.prepare(`SELECT
    SUM(status='going') AS going, SUM(status='waitlist') AS waitlist, SUM(status='not_going') AS not_going
    FROM rsvps WHERE event_id=?`).get(eventId);
  return { going: r.going || 0, waitlist: r.waitlist || 0, not_going: r.not_going || 0 };
}

function nextSeq(db, eventId) {
  return db.prepare('SELECT COALESCE(MAX(queue_seq),0)+1 AS n FROM rsvps WHERE event_id=?').get(eventId).n;
}

function hasRoom(event, goingCount) {
  return event.capacity == null || goingCount < event.capacity;
}

/** Promote waitlisted members into free places, oldest first. Returns promoted user ids. */
function promote(db, eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
  if (!event) return [];
  const promoted = [];
  for (;;) {
    const c = counts(db, eventId);
    if (!hasRoom(event, c.going)) break;
    const next = db.prepare("SELECT user_id FROM rsvps WHERE event_id=? AND status='waitlist' ORDER BY queue_seq, rowid LIMIT 1").get(eventId);
    if (!next) break;
    db.prepare("UPDATE rsvps SET status='going', updated_at=datetime('now') WHERE event_id=? AND user_id=?").run(eventId, next.user_id);
    db.prepare('INSERT INTO notices(user_id,message,link) VALUES (?,?,?)').run(
      next.user_id, `Good news! A space opened up and you're now IN for ${event.title}.`, `/events/${eventId}`);
    promoted.push(next.user_id);
  }
  return promoted;
}

/**
 * Set a member's RSVP. want: 'going' | 'not_going'.
 * 'going' lands on the waitlist when the event is full. Returns { status, promoted:[ids] }.
 */
function setRsvp(db, eventId, userId, want) {
  return db.transaction(() => {
    const event = db.prepare('SELECT * FROM events WHERE id=?').get(eventId);
    if (!event) throw Object.assign(new Error('Event not found'), { code: 'NOT_FOUND' });
    const cur = db.prepare('SELECT * FROM rsvps WHERE event_id=? AND user_id=?').get(eventId, userId);
    if (want === 'going') {
      if (cur && (cur.status === 'going' || cur.status === 'waitlist')) return { status: cur.status, promoted: [] };
      const c = counts(db, eventId);
      const status = hasRoom(event, c.going) && c.waitlist === 0 ? 'going' : 'waitlist';
      // (a non-empty waitlist means nobody can jump the queue even if a space has just appeared)
      db.prepare(`INSERT INTO rsvps(event_id,user_id,status,queue_seq) VALUES (?,?,?,?)
        ON CONFLICT(event_id,user_id) DO UPDATE SET status=excluded.status, queue_seq=excluded.queue_seq, updated_at=datetime('now')`)
        .run(eventId, userId, status, status === 'waitlist' ? nextSeq(db, eventId) : 0);
      const promoted = status === 'waitlist' ? promote(db, eventId) : [];
      const final = db.prepare('SELECT status FROM rsvps WHERE event_id=? AND user_id=?').get(eventId, userId).status;
      return { status: final, promoted };
    }
    if (want === 'not_going') {
      db.prepare(`INSERT INTO rsvps(event_id,user_id,status) VALUES (?,?, 'not_going')
        ON CONFLICT(event_id,user_id) DO UPDATE SET status='not_going', queue_seq=0, updated_at=datetime('now')`).run(eventId, userId);
      return { status: 'not_going', promoted: promote(db, eventId) };
    }
    throw new Error('Unknown RSVP status');
  })();
}

/** Remove an RSVP row entirely (admin/captain). Promotes from the waitlist if a place opens. */
function removeRsvp(db, eventId, userId) {
  return db.transaction(() => {
    db.prepare('DELETE FROM rsvps WHERE event_id=? AND user_id=?').run(eventId, userId);
    return { promoted: promote(db, eventId) };
  })();
}

/** Change capacity (null = unlimited) and promote anyone who now fits. */
function setCapacity(db, eventId, capacity) {
  return db.transaction(() => {
    db.prepare('UPDATE events SET capacity=? WHERE id=?').run(capacity, eventId);
    return { promoted: promote(db, eventId) };
  })();
}

/** Position on the waitlist (1-based) or null. */
function waitlistPosition(db, eventId, userId) {
  const list = db.prepare("SELECT user_id FROM rsvps WHERE event_id=? AND status='waitlist' ORDER BY queue_seq, rowid").all(eventId);
  const i = list.findIndex((r) => r.user_id === userId);
  return i < 0 ? null : i + 1;
}

module.exports = { counts, promote, setRsvp, removeRsvp, setCapacity, waitlistPosition, hasRoom };
