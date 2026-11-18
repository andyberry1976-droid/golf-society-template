'use strict';
// Fantasy League: monthly league table + squads-by-month views, and admin team-entry errors that can't be missed.
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, setSetting } = require('../src/db');
const users = require('../src/lib/users');
const FL = require('../src/lib/fantasy');
const FA = require('../src/lib/fantasy-admin');
const { miniSociety, addEvent, startApp, Client, seedDemoPlusEvents } = require('./helpers');

test('monthly fantasy points: place + playing + beat handicap + birdies + wooden spoon, captain double, multi-day counts in its start month', () => {
  const { db, season, course, ids } = miniSociety([10, 12, 14, 16, 18]);
  const res = (ev, uid, pos, stb = 30) => db.prepare('INSERT INTO results(event_id,user_id,stableford_in,stableford,position) VALUES (?,?,?,?,?)').run(ev, uid, stb, stb, pos);
  const a = addEvent(db, { season, course, title: 'March Medal', date: '2026-03-14', status: 'completed' });
  res(a, ids[0], 1, 38); res(a, ids[1], 2); res(a, ids[2], 3); res(a, ids[3], 4);
  db.prepare("INSERT INTO comp_scores(comp,event_id,user_id,value) VALUES ('birdie',?,?,2)").run(a, ids[1]);
  const b = addEvent(db, { season, course, title: 'Summer Tour', date: '2026-06-30', status: 'completed' });
  db.prepare("UPDATE events SET end_date='2026-07-01' WHERE id=?").run(b);
  res(b, ids[1], 1); res(b, ids[2], 2); res(b, ids[3], 2); res(b, ids[0], 4);
  addEvent(db, { season, course, title: 'Future', date: '2026-09-01', status: 'scheduled' });
  const base = { players: ids.map((id, i) => ({ user_id: id, name: `Player ${i + 1}`, price: 5 })) };
  const names = base.players.map((p) => p.name);
  assert.ok(FA.addTeam(db, 2026, { manager_name: 'Player 77', team_name: 'Player 77 Team', picks: names, captain: 'Player 2' }, base, FL.RULES).ok);
  assert.ok(FA.addTeam(db, 2026, { manager_name: 'Player 76', team_name: 'Player 76 Team', picks: names, captain: 'Player 1' }, base, FL.RULES).ok);
  const m = FL.monthly(db, 2026, FA.teams(db, 2026));
  assert.equal(m.months.length, 12); assert.equal(m.months[2].label, 'Mar');
  const g = m.grid; assert.deepEqual(g.map((x) => [x.pos, x.team.team_name, x.total]), [[1, 'Player 77 Team', 214], [2, 'Player 76 Team', 202]]);
  assert.equal(g[0].months[0], null, 'no event in January: dash'); assert.equal(g[0].months[2], 109); assert.equal(g[0].months[5], 105, 'multi-day June/July event counts in June');
  assert.equal(g[0].months[6], null); assert.equal(g[0].months[8], null, 'scheduled event does not score');
  const sq = m.squads.find((s) => s.team.team_name === 'Player 77 Team');
  const p2 = sq.players.find((p) => p.name === 'Player 2'); assert.ok(p2.captain); assert.equal(p2.months[2], 50); assert.equal(p2.months[5], 56); assert.equal(p2.total, 106);
  const p5 = sq.players.find((p) => p.name === 'Player 5'); assert.equal(p5.months[2], 0, 'did not play: 0 in a month with events');
  assert.equal(sq.players.find((p) => p.name === 'Player 4').months[2], 10, 'wooden spoon');
  // before any events: all dashes, everyone level on 0 in joint first
  const e = FL.monthly(db, 2027, [{ ...FA.teams(db, 2026)[0] }, { ...FA.teams(db, 2026)[1] }]);
  assert.equal(e.scored, false); assert.ok(e.grid.every((x) => x.total === 0 && x.pos === 1 && x.tied && x.months.every((v) => v === null)));
});

function site() {
  const { db } = seedDemoPlusEvents(); setSetting(db, 'feature_fantasy', '1');
  const id = users.createUser(db, { name: 'Test Admin', email: 'fm-admin@t.example', passwordHash: users.hashPassword('password-123'), index: 18, joinedOn: '2025-01-01' });
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(id);
  return db;
}

test('admin team entry: missing captain is shown at the top and by the field, input kept, nothing saved; saved teams show in the public grid and squads', async () => {
  const db = site(); const app = await startApp(db);
  try {
    const anon = new Client(app.base); const adm = new Client(app.base); await adm.login('fm-admin@t.example');
    const { getSettings } = require('../src/db'); const y = db.prepare("SELECT MAX(s.year) y FROM seasons s JOIN events e ON e.season_id=s.id WHERE e.status='completed'").get().y;
    const base = FL.livePrices(db, y, FL.rulesFrom(getSettings(db))); const S = base.season; const listed = FA.pool(db, S, base); const nm = FL.seasonMonths(db, S).length;
    const five = listed.slice().sort((a, b) => a.price - b.price).slice(0, 5).map((p) => p.name);
    const post = async (o) => { const body = new URLSearchParams({ _csrf: await adm.csrf(), manager_name: o.manager_name, team_name: o.team_name, user_id: '', captain: o.captain || '' }); for (const p of o.picks) body.append('picks', p); return adm.req('POST', '/fantasy-league/admin/teams', { form: body }); };
    const pg = (await adm.get('/fantasy-league')).text_;
    assert.match(pg, /action="\/fantasy-league\/admin\/teams#fl-admin"/, 'browser lands on the form after submitting');
    let r = await post({ manager_name: 'Player 76', team_name: 'Captainless', picks: five });
    assert.equal(r.status, 422);
    assert.match(r.text_, /id="fl-not-saved"[^>]*><strong>Team not saved:<\/strong>[^<]*Pick a captain/, 'error banner at the top');
    assert.ok(r.text_.indexOf('fl-not-saved') < r.text_.indexOf('Player prices for'), 'banner above the content');
    assert.match(r.text_, /id="fa-t-cap"[\s\S]*?<p class="ferr" role="alert">Pick a captain/, 'error next to the captain field');
    assert.match(r.text_, /id="fa-t-name" name="team_name" maxlength="40" value="Captainless"/, 'team name kept');
    for (const n of five) assert.match(r.text_, new RegExp(`<option value="${n}" selected>`), `${n} still picked`);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM fantasy_teams').get().n, 0);
    assert.doesNotMatch((await anon.get('/fantasy-league')).text_, /fl-not-saved|League table/);
    r = await post({ manager_name: 'Player 76', team_name: 'Player 76 Team', picks: five, captain: five[1] }); assert.equal(r.status, 302);
    const pub = (await anon.get('/fantasy-league')).text_;
    assert.match(pub, /Teams entered \(1\)/);
    assert.match(pub, new RegExp(`League table ${S}: points by month`)); assert.match(pub, /No events scored yet/);
    assert.match(pub, new RegExp(`<th class="st" scope="row">Player 76<small>Player 76 Team</small></th>(<td class="nil">–</td>){${nm}}<td class="tot">0</td>`));
    assert.match(pub, /Squads month by month/); assert.match(pub, new RegExp(`${five[1]} \\(C\\)</th>`));
    assert.match(pub, /<table class="gt fl-grid">/); assert.match(pub, /<th class="st">Manager<small>Team<\/small><\/th>/);
  } finally { await app.close(); }
});
