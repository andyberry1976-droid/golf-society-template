import { launch, startServer } from './lib.mjs';
// Layout check on the Demo seed: no horizontal scroll, 44px tap targets, no JS errors at 320-1440px.
// SHOTS_DIR=/some/dir node e2e/mobile.mjs  also saves 390px full-page screenshots there.
process.env.E2E_SEED='demo';
const SHOTS = process.env.SHOTS_DIR;
const srv = await startServer({ port: 3198, dbPath: '/tmp/bog-shots.db' });
const browser = await launch();
const pages = ['/', '/handicaps', '/standings', '/competitions', '/birdie-league', '/fedex', '/matchplay', '/majors', '/hall-of-fame', '/rules', '/players', '/players/1', '/events', '/honours'];
const adminPages = ['/admin', '/admin/comps', '/admin/matchplay/1', '/admin/tournaments', '/admin/members', '/admin/members/1', '/admin/settings'];
let bad = 0;
for (const w of [320, 390, 768, 1100, 1440]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 800 }, deviceScaleFactor: w===390?2:1 });
  const p = await ctx.newPage();
  const errs=[]; p.on('pageerror', e=>errs.push(String(e)));
  await p.goto(srv.base + '/login'); await p.fill('input[name=email]', 'admin@example.test'); await p.fill('input[name=password]', 'flamingo-demo-1'); await Promise.all([p.waitForNavigation(), p.click('form[action="/login"] button[type=submit]')]);
  for (const path of [...pages, ...adminPages]) {
    await p.goto(srv.base + path, { waitUntil: 'load' });
    const r = await p.evaluate(() => {
      const over = document.documentElement.scrollWidth - window.innerWidth;
      const small = [...document.querySelectorAll('a,button,input,select,textarea')].filter(e => { const b = e.getBoundingClientRect(); if (!b.width || !b.height) return false; if (e.closest('.xs table td, .xs table th')&&e.tagName==='A') return false; if (e.closest('p,li,td,small,.hint,.sub,.lead')&&e.tagName==='A') return false; if (e.type==='hidden') return false; return b.height < 44 && !['checkbox','radio'].includes(e.type); }).map(e => (e.tagName + ' ' + (e.textContent||e.name||'').trim().slice(0, 25) + ' h' + Math.round(e.getBoundingClientRect().height)));
      return { over, small: small.slice(0, 4), nsmall: small.length };
    });
    if (r.over > 0 || r.nsmall) { bad++; console.log(w, path, 'overflow', r.over, 'small', r.nsmall, r.small.join(' | ')); }
  }
  if (errs.length) console.log(w,'JS errors', errs);
  if (w === 390 && SHOTS) {
    await p.goto(srv.base + '/logout').catch(()=>{});
    const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    const q = await ctx2.newPage();
    for (const [path, name] of [['/', 'home'], ['/standings', 'order-of-merit'], ['/birdie-league', 'birdie-league'], ['/fedex', 'fedex'], ['/matchplay', 'matchplay'], ['/majors', 'majors'], ['/hall-of-fame', 'hall-of-fame'], ['/rules','rules'], ['/handicaps','handicaps'], ['/players/1', 'profile-ben-wall']]) {
      await q.goto(srv.base + path, { waitUntil: 'load' });
      await q.screenshot({ path: `${SHOTS}/${name}-390.png`, fullPage: true });
    }
    await ctx2.close();
  }
  await ctx.close();
}
console.log(bad ? `LAYOUT ISSUES: ${bad}` : 'LAYOUT OK (17+ pages x 5 widths)');
await browser.close(); await srv.stop(); process.exit(bad ? 1 : 0);
