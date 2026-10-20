'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { miniSociety, addEvent } = require('./helpers');
const R = require('../src/lib/rsvp');

const status = (db, ev, uid) => (db.prepare('SELECT status FROM rsvps WHERE event_id=? AND user_id=?').get(ev, uid) || {}).status;

test('going until capacity, then waitlist', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14, 16]);
  const ev = addEvent(db, { season, course, capacity: 2 });
  assert.equal(R.setRsvp(db, ev, ids[0], 'going').status, 'going');
  assert.equal(R.setRsvp(db, ev, ids[1], 'going').status, 'going');
  assert.equal(R.setRsvp(db, ev, ids[2], 'going').status, 'waitlist');
  assert.equal(R.setRsvp(db, ev, ids[3], 'going').status, 'waitlist');
  assert.deepEqual(R.counts(db, ev), { going: 2, waitlist: 2, not_going: 0 });
  assert.equal(R.waitlistPosition(db, ev, ids[2]), 1);
  assert.equal(R.waitlistPosition(db, ev, ids[3]), 2);
});

test('cancelling a place promotes the first waitlisted member (FIFO) and notifies them', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14, 16]);
  const ev = addEvent(db, { season, course, capacity: 2 });
  ids.forEach((id) => R.setRsvp(db, ev, id, 'going'));
  const out = R.setRsvp(db, ev, ids[0], 'not_going');
  assert.deepEqual(out.promoted, [ids[2]]);
  assert.equal(status(db, ev, ids[2]), 'going');
  assert.equal(status(db, ev, ids[3]), 'waitlist');
  assert.equal(R.waitlistPosition(db, ev, ids[3]), 1);
  const n = db.prepare('SELECT * FROM notices WHERE user_id=?').all(ids[2]);
  assert.equal(n.length, 1);
  assert.match(n[0].message, /now IN/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notices WHERE user_id=?').get(ids[3]).n, 0);
});

test('a waitlisted member leaving does not disturb the order', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14, 16]);
  const ev = addEvent(db, { season, course, capacity: 1 });
  ids.forEach((id) => R.setRsvp(db, ev, id, 'going')); // 0 going; 1,2,3 waitlist
  R.setRsvp(db, ev, ids[2], 'not_going'); // middle of queue leaves
  assert.equal(R.waitlistPosition(db, ev, ids[1]), 1);
  assert.equal(R.waitlistPosition(db, ev, ids[3]), 2);
  assert.equal(R.counts(db, ev).going, 1);
});

test('re-joining after dropping out goes to the back of the queue', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14, 16]);
  const ev = addEvent(db, { season, course, capacity: 1 });
  R.setRsvp(db, ev, ids[0], 'going');
  R.setRsvp(db, ev, ids[1], 'going'); // wait 1
  R.setRsvp(db, ev, ids[2], 'going'); // wait 2
  R.setRsvp(db, ev, ids[1], 'not_going');
  R.setRsvp(db, ev, ids[1], 'going'); // back in, behind ids[2]
  assert.equal(R.waitlistPosition(db, ev, ids[2]), 1);
  assert.equal(R.waitlistPosition(db, ev, ids[1]), 2);
});

test('nobody can jump the queue; repeated clicks are idempotent', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14]);
  const ev = addEvent(db, { season, course, capacity: 1 });
  R.setRsvp(db, ev, ids[0], 'going');
  assert.equal(R.setRsvp(db, ev, ids[1], 'going').status, 'waitlist');
  assert.equal(R.setRsvp(db, ev, ids[1], 'going').status, 'waitlist');
  assert.equal(R.counts(db, ev).waitlist, 1);
  assert.equal(R.setRsvp(db, ev, ids[0], 'going').status, 'going');
  assert.equal(R.counts(db, ev).going, 1);
});

test('raising capacity promotes from the waitlist; lowering never evicts', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14, 16]);
  const ev = addEvent(db, { season, course, capacity: 1 });
  ids.forEach((id) => R.setRsvp(db, ev, id, 'going'));
  const up = R.setCapacity(db, ev, 3);
  assert.deepEqual(up.promoted, [ids[1], ids[2]]);
  assert.deepEqual(R.counts(db, ev), { going: 3, waitlist: 1, not_going: 0 });
  R.setCapacity(db, ev, 1);
  assert.equal(R.counts(db, ev).going, 3); // existing places are kept
  R.setCapacity(db, ev, null); // unlimited
  assert.deepEqual(R.counts(db, ev), { going: 4, waitlist: 0, not_going: 0 });
});

test('admin removal of a going member promotes the next in line', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14]);
  const ev = addEvent(db, { season, course, capacity: 1 });
  ids.forEach((id) => R.setRsvp(db, ev, id, 'going'));
  const out = R.removeRsvp(db, ev, ids[0]);
  assert.deepEqual(out.promoted, [ids[1]]);
  assert.equal(status(db, ev, ids[0]), undefined);
});

test('unlimited events never waitlist', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14, 16]);
  const ev = addEvent(db, { season, course, capacity: null });
  ids.forEach((id) => assert.equal(R.setRsvp(db, ev, id, 'going').status, 'going'));
});

test('unknown event / status are rejected', () => {
  const { db, season, course, ids } = miniSociety([10]);
  const ev = addEvent(db, { season, course });
  assert.throws(() => R.setRsvp(db, 9999, ids[0], 'going'), /not found/i);
  assert.throws(() => R.setRsvp(db, ev, ids[0], 'maybe'), /Unknown/);
});
