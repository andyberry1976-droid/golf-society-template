'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, Client, seedDemoPlusEvents } = require('./helpers');
const { open, getSettings, setSetting } = require('../src/db');
const Fe = require('../src/lib/features');

test('SOCIETY_FEATURES parsing', () => {
  const a = Fe.parseEnv('-rsvp, awards=off');
  assert.equal(a.rsvp, '0'); assert.equal(a.awards, '0'); assert.equal(a.oom, '1');
  assert.equal(Fe.parseEnv('none,oom').oom, '1'); assert.equal(Fe.parseEnv('none,oom').fedex, '0');
  assert.equal(Fe.parseEnv('').rsvp, '1');
});

test('features: Demo seed has RSVPs off; toggling hides nav, 404s and restores', async () => {
  process.env.BCRYPT_ROUNDS = '4';
  const { db, upcoming: ev } = seedDemoPlusEvents();
  const S = getSettings(db);
  assert.equal(S.feature_rsvp, '0');
  for (const k of Fe.KEYS.filter((k) => k !== 'rsvp')) assert.equal(S[`feature_${k}`], '1', k);
  const app = await startApp(db);
  try {
    const anon = new Client(app.base);
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    // RSVP off: no buttons, counts or waitlist
    for (const c of [anon, adm]) {
      const e = await c.get(`/events/${ev}`);
      assert.equal(e.status, 200);
      assert.doesNotMatch(e.text_, /I’m in|Join the waitlist|Log in to RSVP|spaces left|Who’s in|Waitlist/);
      assert.doesNotMatch((await c.get('/events')).text_, /I’m in|waitlist|spaces left/i);
      assert.doesNotMatch((await c.get('/')).text_, /I’m in|Join the waitlist|spaces left/);
    }
    const rsvpCount = db.prepare('SELECT COUNT(*) n FROM rsvps').get().n;
    assert.ok(rsvpCount > 0, 'RSVP data kept');
    assert.equal((await adm.post(`/events/${ev}/rsvp`, { status: 'going' })).status, 404);

    // switch Awards and Matchplay off via the admin form
    const page = await adm.get('/admin/settings');
    assert.match(page.text_, /Features/); assert.match(page.text_, /Handicap Records/);
    const body = { features_form: '1' };
    for (const k of Fe.KEYS) if (!['rsvp', 'awards', 'matchplay'].includes(k)) body[`feature_${k}`] = '1';
    const keep = getSettings(db);
    for (const k of ['society_name', 'short_name', 'hero_title', 'currency', 'default_allowance', 'max_index', 'default_start_index']) body[k] = keep[k];
    body.positions = '30, 24, 20'; body.oom_mode = 'score'; body.best_n = '7'; body.countback = '1'; body.participation = '0';
    assert.equal((await adm.post('/admin/settings', body)).status, 302);
    assert.equal(getSettings(db).feature_awards, '0');
    const home = (await anon.get('/')).text_;
    assert.doesNotMatch(home, /href="\/awards"/); assert.doesNotMatch(home, /href="\/matchplay"/);
    assert.match(home, /href="\/handicaps"/);
    assert.doesNotMatch((await anon.get('/competitions')).text_, /href="\/matchplay"/);
    assert.equal((await anon.get('/awards')).status, 404);
    assert.equal((await anon.get('/matchplay')).status, 404);
    assert.equal((await adm.get('/admin/matchplay')).status, 404);
    assert.doesNotMatch((await adm.get('/admin')).text_, /href="\/admin\/matchplay"/);

    // back on: everything restored
    setSetting(db, 'feature_awards', '1'); setSetting(db, 'feature_matchplay', '1');
    assert.equal((await anon.get('/awards')).status, 200);
    const mp = await anon.get('/matchplay'); assert.equal(mp.status, 200); assert.match(mp.text_, /Matchplay/);
    assert.match((await anon.get('/')).text_, /href="\/matchplay"/);
    // RSVP back on: buttons return, data intact
    setSetting(db, 'feature_rsvp', '1');
    assert.match((await adm.get(`/events/${ev}`)).text_, /Who’s in/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rsvps').get().n, rsvpCount);
  } finally { await app.close(); }
});
