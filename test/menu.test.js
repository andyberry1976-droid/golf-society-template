'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open, setSetting } = require('../src/db');
const { seedDemo } = require('../scripts/seed-demo-site');
const { startApp, Client } = require('./helpers');

const RES = ['/standings', '/fedex', '/birdie-league', '/matchplay', '/majors', '/ryder-cup', '/texas-scramble', '/leagues', '/honours', '/hall-of-fame', '/records'];
const PLY = ['/players', '/handicaps', '/awards', '/prize-money'];
const hrefs = (html) => [...html.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]);

test('menu: short top level, Players and Results dropdowns + mobile groups + footer columns', async () => {
  const db = open(':memory:'); seedDemo(db);
  for (const k of ['birthdays', 'fantasy', 'ryder']) setSetting(db, 'feature_' + k, '1');
  const app = await startApp(db);
  try {
    const c = new Client(app.base);
    const h = (await c.get('/')).text_;
    const nav = h.slice(h.indexOf('aria-label="Primary"'), h.indexOf('</nav>', h.indexOf('aria-label="Primary"')));
    const dd = (id) => { const st = nav.indexOf(`id="${id}"`); return nav.slice(st, nav.indexOf('</div></div>', st)); };
    const top = hrefs(nav.replace(/<div class="dd" data-dd>[\s\S]*?<\/div><\/div>/g, ''));
    assert.deepEqual(top, ['/', '/events', '/fantasy-league', '/rules', '/birthdays']);
    assert.ok(nav.indexOf('aria-controls="dd-players"') < nav.indexOf('aria-controls="dd-results"'), 'Players before Results');
    assert.match(nav, /<button type="button" class="dd-b[^"]*" aria-expanded="false" aria-controls="dd-players"[^>]*>Players/);
    assert.match(nav, /<button type="button" class="dd-b[^"]*" aria-expanded="false" aria-controls="dd-results"[^>]*>Results/);
    assert.deepEqual(hrefs(dd('dd-players')), PLY); assert.match(dd('dd-players'), /<a href="\/players">All players<\/a><a href="\/handicaps">Handicap Records<\/a><a href="\/awards">Awards<\/a><a href="\/prize-money">Prize Money<\/a>/);
    assert.deepEqual(hrefs(dd('dd-results')), RES);
    const mob = h.slice(h.indexOf('id="mobile-nav"'), h.indexOf('</nav>', h.indexOf('id="mobile-nav"')));
    const grp = (id) => { const st = mob.indexOf(`id="${id}"`); return mob.slice(st, mob.indexOf('</details>', st)); };
    assert.match(mob, /<details class="msub"><summary aria-controls="m-players" aria-expanded="false">Players<\/summary>/);
    assert.match(mob, /<details class="msub"><summary aria-controls="m-results" aria-expanded="false">Results<\/summary>/);
    assert.ok(mob.indexOf('m-players') < mob.indexOf('m-results'));
    assert.deepEqual(hrefs(grp('m-players')), PLY); assert.deepEqual(hrefs(grp('m-results')), RES);
    assert.deepEqual(hrefs(mob.slice(0, mob.indexOf('<details'))), ['/', '/events']);
    assert.match(h, /<html lang="en-GB" class="no-js">/, 'no-JS fallback hook');
    const foot = h.slice(h.indexOf('<footer'));
    const col = (name) => { const st = foot.indexOf(`<h2>${name}</h2>`); return foot.slice(st, foot.indexOf('</ul>', st)); };
    const ex = col('Explore'); assert.deepEqual(hrefs(ex).slice(-1), ['/birthdays'], 'Birthdays last in Explore'); assert.ok(!hrefs(ex).includes('/players'));
    assert.deepEqual(hrefs(col('Players')), PLY, 'footer Players column'); assert.deepEqual(hrefs(col('Results')), RES, 'footer Results column');
    // on a Results page that group is open and the page is marked current; Players stays closed
    let r = (await c.get('/records')).text_;
    assert.match(r, /<details class="msub" open><summary aria-controls="m-results"/); assert.match(r, /<details class="msub"><summary aria-controls="m-players"/);
    assert.match(r, /class="dd-b on"[^>]*aria-controls="dd-results"/); assert.doesNotMatch(r, /class="dd-b on"[^>]*aria-controls="dd-players"/);
    assert.match(r, /<a href="\/records" aria-current="page">/);
    // on a Players page (incl. the moved ones) the Players group is open instead
    for (const p of PLY) {
      r = (await c.get(p)).text_;
      assert.match(r, /<details class="msub" open><summary aria-controls="m-players"/, p); assert.match(r, /<details class="msub"><summary aria-controls="m-results"/, p);
      assert.match(r, /class="dd-b on"[^>]*aria-controls="dd-players"/, p); assert.match(r, new RegExp(`<a href="${p}" aria-current="page">`), p);
    }
    const pid = db.prepare("SELECT id FROM users WHERE status='active' LIMIT 1").get().id;
    assert.match((await c.get(`/players/${pid}`)).text_, /<details class="msub" open><summary aria-controls="m-players"/, 'a player profile opens Players');
    // 'All competitions' is gone from the menus, but /competitions still works for old links
    assert.doesNotMatch(h, /All competitions/); assert.equal((await c.get('/competitions')).status, 200);
    // switched-off modules drop out of their submenu
    setSetting(db, 'feature_prizes', '0');
    r = (await c.get('/')).text_; assert.doesNotMatch(r, /href="\/prize-money"/); assert.match(r, /href="\/awards"/);
    // switched-off modules drop out of the submenu
    setSetting(db, 'feature_fedex', '0');
    assert.doesNotMatch((await c.get('/')).text_, /href="\/fedex"/);
  } finally { await app.close(); }
});
