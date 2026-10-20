// Screenshots + automated mobile-quality audit at 320 / 390 / 768 / 1024 / 1440 px.
// Seeds a throwaway DB (port 3198), logs in as demo admin for admin pages, writes PNGs to screenshots/
// and a machine-readable report to screenshots/audit.json (+ prints a summary).
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import Database from 'better-sqlite3';
import { launch, startServer, ACCOUNTS, DEMO_PASSWORD } from './lib.mjs';

const WIDTHS = [320, 390, 768, 1024, 1440];
const OUT = new URL('../screenshots/', import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const srv = await startServer({ port: Number(process.env.SHOT_PORT || 3198), dbPath: '/tmp/fairway-shots.db' });
const db = new Database(srv.dbPath, { readonly: true });
const fullEvent = db.prepare("SELECT id FROM events WHERE status='scheduled' AND capacity IS NOT NULL AND (SELECT COUNT(*) FROM rsvps r WHERE r.event_id=events.id AND status='waitlist')>0").get().id;
const doneEvent = db.prepare("SELECT id FROM events WHERE status='completed' ORDER BY event_date DESC LIMIT 1").get().id;
const star = db.prepare("SELECT id FROM users WHERE email='player38@example.test'").get().id;
db.close();

const PAGES = [
  ['home', '/', false],
  ['events', '/events', false],
  ['event-full-waitlist', `/events/${fullEvent}`, false],
  ['event-results', `/events/${doneEvent}`, false],
  ['players', '/players', false],
  ['profile', `/players/${star}`, false],
  ['standings', '/standings', false],
  ['records', '/records', false],
  ['roll-of-honour', '/honours', false],
  ['awards', '/awards', false],
  ['login', '/login', false],
  ['join', '/join', false],
  ['admin-dashboard', '/admin', true],
  ['admin-results-entry', `/admin/events/${fullEvent}/results`, true],
  ['admin-members', '/admin/members', true],
  ['admin-seasons', '/admin/seasons', true],
  ['admin-settings', '/admin/settings', true],
];

const browser = await launch();
const report = [];
const audit = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; };
  const doc = document.documentElement;
  const overflow = doc.scrollWidth - doc.clientWidth;
  // elements poking outside the viewport (ignoring things clipped by an overflow:hidden ancestor)
  const wide = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > doc.clientWidth + 1 && !(el.closest('.sr') || el.closest('[aria-hidden=true]'))) {
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { const o = getComputedStyle(p).overflowX; if (o !== 'visible') { clipped = true; break; } }
      if (!clipped) wide.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0]);
    }
  }
  // tap targets: visible interactive controls (inline links inside running text are exempt, per WCAG 2.5.8)
  const small = [];
  const sel = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button]';
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || el.closest('.sr')) continue;
    if (el.matches('input[type=checkbox],input[type=radio]')) { const l = el.closest('label'); if (l && vis(l) && l.getBoundingClientRect().height >= 44) continue; }
    if (el.tagName === 'A' && el.closest('p, li, td, .fine, .hint, .sm, .muted, dd') && getComputedStyle(el).display === 'inline') continue;
    const r = el.getBoundingClientRect();
    if (r.height < 43.5 || r.width < 43.5) small.push(`${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(' ')[0] : ''} "${(el.innerText || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 24)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  // text smaller than 16px (body copy); count distinct text nodes
  const tiny = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = walker.nextNode()); ) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement; if (!el || !vis(el) || el.closest('.sr, script, style, svg')) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 15.99) { const k = fs + 'px'; tiny.set(k, (tiny.get(k) || 0) + 1); }
  }
  // colour contrast (WCAG AA): text colour vs the first opaque ancestor background (gradient/image backgrounds are skipped)
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r, g, b, a }; };
  const lum = ({ r, g, b }) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const lowContrast = new Map();
  const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w2.nextNode()); ) {
    if (!n.nodeValue.trim()) continue;
    const el = n.parentElement; if (!el || !vis(el) || el.closest('.sr, script, style, svg, [disabled]')) continue;
    let bg = null, skip = false;
    for (let q = el; q; q = q.parentElement) { const st = getComputedStyle(q); if (st.backgroundImage !== 'none') { skip = true; break; } const c = parse(st.backgroundColor); if (c && c.a > 0.95) { bg = c; break; } }
    if (skip || !bg) continue;
    const fg = parse(getComputedStyle(el).color); if (!fg) continue;
    const L1 = lum(fg), L2 = lum(bg); const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const st = getComputedStyle(el); const px = parseFloat(st.fontSize); const bold = parseInt(st.fontWeight, 10) >= 700;
    const need = px >= 24 || (bold && px >= 18.66) ? 3 : 4.5;
    if (ratio < need) { const k = `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${ratio.toFixed(2)}<${need} "${n.nodeValue.trim().slice(0, 20)}"`; lowContrast.set(k, 1); }
  }
  const imgsNoAlt = [...document.querySelectorAll('img:not([alt])')].length;
  const h1 = document.querySelectorAll('h1').length;
  const hasMain = !!document.querySelector('main');
  const lang = document.documentElement.lang;
  return { lowContrast: [...lowContrast.keys()].slice(0, 8), overflow, wide: [...new Set(wide)].slice(0, 5), small: [...new Set(small)], tiny: Object.fromEntries(tiny), imgsNoAlt, h1, hasMain, lang };
};

for (const needAdmin of [false, true]) {
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width: w, height: w < 700 ? 800 : 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    if (needAdmin) {
      await page.goto(srv.base + '/login');
      await page.fill('[name=email]', ACCOUNTS.admin);
      await page.fill('[name=password]', DEMO_PASSWORD);
      await Promise.all([page.waitForNavigation(), page.click('button[type=submit]:has-text("Log in")')]);
    }
    for (const [name, path, adm] of PAGES) {
      if (adm !== needAdmin) continue;
      const resp = await page.goto(srv.base + path, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      const a = await page.evaluate(audit);
      await page.screenshot({ path: `${OUT}${name}-${w}.png`, fullPage: true });
      report.push({ page: name, width: w, status: resp.status(), jsErrors: errs.splice(0), ...a });
    }
    await ctx.close();
  }
}
await browser.close();
await srv.stop();
writeFileSync(OUT + 'audit.json', JSON.stringify(report, null, 2));

// ---- summary ----
const bad = (r) => r.overflow > 0 || r.wide.length || r.jsErrors.length || r.status !== 200;
console.log(`Pages x widths audited: ${report.length}  (${PAGES.length} pages x ${WIDTHS.length} widths)`);
console.log('Horizontal overflow:', report.filter((r) => r.overflow > 0 || r.wide.length).map((r) => `${r.page}@${r.width}(+${r.overflow})`).join(', ') || 'none');
console.log('HTTP != 200 or JS errors:', report.filter((r) => r.status !== 200 || r.jsErrors.length).map((r) => `${r.page}@${r.width}`).join(', ') || 'none');
const smalls = new Map();
for (const r of report) for (const s of r.small) smalls.set(s.replace(/ \d+x\d+$/, ''), (smalls.get(s.replace(/ \d+x\d+$/, '')) || 0) + 1);
console.log('Tap targets <44px:', smalls.size ? '\n  ' + [...smalls].map(([k, v]) => `${k} (${v} page/width combos)`).join('\n  ') : 'none');
const tinies = {};
for (const r of report) for (const [k, v] of Object.entries(r.tiny)) tinies[k] = (tinies[k] || 0) + v;
console.log('Visible text nodes under 16px (all pages/widths):', JSON.stringify(tinies));
const lc = new Map();
for (const r of report) for (const k of r.lowContrast) lc.set(k, (lc.get(k) || 0) + 1);
console.log('Contrast below WCAG AA (solid backgrounds only):', lc.size ? '\n  ' + [...lc.keys()].join('\n  ') : 'none');
console.log('Missing <main>/<h1>/lang:', report.filter((r) => !r.hasMain || r.h1 !== 1 || !r.lang).map((r) => `${r.page}@${r.width}`).join(', ') || 'none', '| imgs without alt:', report.reduce((n, r) => n + r.imgsNoAlt, 0));
process.exitCode = report.some(bad) ? 1 : 0;
