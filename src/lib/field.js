'use strict';
/**
 * An event's field (who is playing). Stored explicitly in event_players so it works with RSVPs off;
 * anyone with a result, a Birdie/FedEx entry or a 'going' RSVP also counts as in the field.
 */
const { recomputeAll } = require('./engine');

const FIELD_SQL = `SELECT user_id FROM event_players WHERE event_id=@e
  UNION SELECT user_id FROM results WHERE event_id=@e
  UNION SELECT user_id FROM comp_scores WHERE event_id=@e
  UNION SELECT user_id FROM rsvps WHERE event_id=@e AND status='going'`;

/** [{id,name,nickname,handicap_index,playing,res:{...}|null,comps:{birdie,fedex}}] sorted by name. */
function list(db, eventId) {
  const res = new Map(db.prepare('SELECT * FROM results WHERE event_id=?').all(eventId).map((r) => [r.user_id, r]));
  const comps = new Map();
  for (const c of db.prepare('SELECT comp, user_id, value FROM comp_scores WHERE event_id=?').all(eventId)) {
    if (!comps.has(c.user_id)) comps.set(c.user_id, {});
    comps.get(c.user_id)[c.comp] = c.value;
  }
  return db.prepare(`SELECT u.id, u.name, u.nickname, u.handicap_index, u.status FROM users u WHERE u.id IN (${FIELD_SQL}) ORDER BY u.name`).all({ e: eventId })
    .map((u) => ({ ...u, playing: u.handicap_index == null ? null : Math.round(u.handicap_index + 1e-9), res: res.get(u.id) || null, comps: comps.get(u.id) || {} }));
}

/** Active members not yet in the field. */
function candidates(db, eventId) {
  return db.prepare(`SELECT id, name, nickname, handicap_index FROM users WHERE status='active' AND id NOT IN (${FIELD_SQL}) ORDER BY name`).all({ e: eventId });
}

const inField = (db, eventId, userId) => !!db.prepare(`SELECT 1 FROM (${FIELD_SQL}) WHERE user_id=@u`).get({ e: eventId, u: userId });

function add(db, eventId, userIds, actorId) {
  const ins = db.prepare('INSERT OR IGNORE INTO event_players(event_id,user_id,added_by) VALUES (?,?,?)');
  const added = [];
  db.transaction(() => {
    for (const uid of userIds) {
      const u = db.prepare("SELECT id, name FROM users WHERE id=? AND status='active'").get(uid);
      if (!u) throw Object.assign(new Error('Unknown or inactive member'), { code: 'INVALID' });
      if (inField(db, eventId, uid)) continue;
      ins.run(eventId, uid, actorId || null); added.push(u);
    }
  })();
  return added;
}

/**
 * Take a player out of an event: their result, Birdie/FedEx entries, RSVP and field entry go, then
 * everything derived (positions, OoM points, honours, handicaps) is recomputed. Returns what was removed.
 */
function remove(db, eventId, userId) {
  const out = { result: null, comps: [], rsvp: null };
  db.transaction(() => {
    out.result = db.prepare('SELECT * FROM results WHERE event_id=? AND user_id=?').get(eventId, userId) || null;
    out.comps = db.prepare('SELECT comp, value FROM comp_scores WHERE event_id=? AND user_id=?').all(eventId, userId);
    out.rsvp = db.prepare('SELECT status FROM rsvps WHERE event_id=? AND user_id=?').get(eventId, userId) || null;
    db.prepare('DELETE FROM results WHERE event_id=? AND user_id=?').run(eventId, userId);
    db.prepare('DELETE FROM comp_scores WHERE event_id=? AND user_id=?').run(eventId, userId);
    db.prepare('DELETE FROM event_players WHERE event_id=? AND user_id=?').run(eventId, userId);
    if (out.rsvp) require('./rsvp').removeRsvp(db, eventId, userId); // frees the place (promotes the waitlist)
    // no results left: a completed event goes back to scheduled (same as clearing results)
    if (out.result && !db.prepare('SELECT 1 FROM results WHERE event_id=?').get(eventId)) db.prepare("UPDATE events SET status='scheduled' WHERE id=? AND status='completed'").run(eventId);
    recomputeAll(db);
  })();
  return out;
}

/** One-off: put everyone already in an event (results, comp entries, going RSVPs) into event_players. */
function backfill(db) {
  db.exec(`INSERT OR IGNORE INTO event_players(event_id,user_id) SELECT event_id, user_id FROM results;
    INSERT OR IGNORE INTO event_players(event_id,user_id) SELECT event_id, user_id FROM comp_scores;
    INSERT OR IGNORE INTO event_players(event_id,user_id) SELECT event_id, user_id FROM rsvps WHERE status='going';`);
}

module.exports = { list, candidates, add, remove, backfill, inField };
