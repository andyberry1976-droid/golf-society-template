'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { startApp, Client, seedDemoPlusEvents } = require('./helpers');
const { seedDemo } = require('../scripts/seed-demo-site');

test('admin-only sign-in (Demo): members/captains refused, no My account / Log in / Join, admin link in footer', async () => {
  const db = open(':memory:'); seedDemo(db, { with2025: false });
  assert.equal(require('../src/site').load('demo').auth.admin_only, true);
  const before = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const app = await startApp(db, { adminLoginOnly: true });
  try {
    const anon = new Client(app.base);
    const home = (await anon.get('/')).text_;
    assert.doesNotMatch(home, /My account|href="\/join"|>Log in</);
    assert.match(home, /<a href="\/login"[^>]*>Admin<\/a>/);
    assert.equal((await anon.get('/join')).status, 404);
    assert.equal((await anon.get('/login')).status, 200);
    for (const who of ['captain', 'member']) {
      const c = new Client(app.base); assert.equal((await c.login(`${who}@example.test`, 'flamingo-demo-1')).status, 401, who);
      assert.equal((await c.get('/account')).status === 200, false, who);
      assert.notEqual((await c.get('/admin')).status, 200, who);
    }
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    const a = (await adm.get('/')).text_;
    assert.doesNotMatch(a, /My account/); assert.match(a, /Log out/); assert.match(a, /href="\/admin"/);
    assert.equal((await adm.get('/admin')).status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, before); // nobody deleted or changed
  } finally { await app.close(); }
});

test('upcoming event page shows the Playing field publicly (RSVPs off); past events keep results', async () => {
  const { db, upcoming, past } = seedDemoPlusEvents();
  const app = await startApp(db, { adminLoginOnly: true });
  try {
    const ev = upcoming;
    const n = require('../src/lib/field').list(db, ev).length;
    assert.ok(n > 0);
    const t = (await new Client(app.base).get('/events/' + ev)).text_;
    assert.match(t, new RegExp(`Playing <span class="badge dk">${n}</span>`));
    assert.match(t, /HCP \d/);
    const p = (await new Client(app.base).get('/events/' + past)).text_;
    assert.doesNotMatch(p, /id="go-h">Playing/); assert.match(p, /Results/);
  } finally { await app.close(); }
});
