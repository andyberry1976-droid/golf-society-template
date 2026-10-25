'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, setSetting } = require('../src/db');
const { seedDemo } = require('../scripts/seed-demo-site');
const { startApp, Client } = require('./helpers');

const RES = ['/competitions', '/standings', '/fedex', '/birdie-league', '/matchplay', '/majors', '/ryder-cup', '/texas-scramble', '/leagues', '/honours', '/hall-of-fame', '/records', '/handicaps', '/awards', '/prize-money'];
const hrefs = (html) => [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);

test('menu: short top level, Results dropdown + mobile group + footer column', async () => {
  const db = open(':memory:'); seedDemo(db);
  for (const k of ['birthdays', 'fantasy', 'ryder']) setSetting(db, 'feature_' + k, '1');
  const app = await startApp(db);
  try {
    const c = new Client(app.base);
    const h = (await c.get('/')).text_;
    const nav = h.slice(h.indexOf('aria-label="Primary"'), h.indexOf('</nav>', h.indexOf('aria-label="Primary"')));
    const ddStart = nav.indexOf('class="dd-m"'), ddEnd = nav.indexOf('</div></div>', ddStart);
    const top = hrefs(nav.slice(0, nav.indexOf('class="dd"')) + nav.slice(ddEnd));
    assert.deepEqual(top, ['/', '/events', '/players', '/fantasy-league', '/rules', '/birthdays']);
    assert.match(nav, /<button type="button" class="dd-b[^"]*" aria-expanded="false" aria-controls="dd-results"[^>]*>Results/);
    assert.deepEqual(hrefs(nav.slice(ddStart, ddEnd)), RES);
    const mob = h.slice(h.indexOf('id="mobile-nav"'), h.indexOf('</nav>', h.indexOf('id="mobile-nav"')));
    assert.match(mob, /<details class="msub"><summary aria-controls="m-results" aria-expanded="false">Results<\/summary>/);
    for (const p of RES) assert.ok(mob.includes(`href="${p}"`), p);
    assert.match(h, /<html lang="en-GB" class="no-js">/, 'no-JS fallback hook');
    const foot = h.slice(h.indexOf('<footer'));
    const ex = foot.slice(foot.indexOf('<h2>Explore</h2>'), foot.indexOf('<h2>Results</h2>')); assert.deepEqual(hrefs(ex).slice(-1), ['/birthdays'], 'Birthdays last in Explore');
    assert.match(foot, /<h2>Results<\/h2>/); for (const p of RES) assert.ok(foot.includes(`href="${p}"`), 'footer ' + p);
    // on a Results page the group is open and the page is marked current
    const r = (await c.get('/records')).text_;
    assert.match(r, /<details class="msub" open>/); assert.match(r, /class="dd-b on"/); assert.match(r, /<a href="\/records" aria-current="page">/);
    // switched-off modules drop out of the submenu
    setSetting(db, 'feature_fedex', '0');
    assert.doesNotMatch((await c.get('/')).text_, /href="\/fedex"/);
  } finally { await app.close(); }
});
