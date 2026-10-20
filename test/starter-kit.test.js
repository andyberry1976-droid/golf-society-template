'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const site = require('../src/site');
const rules = require('../src/rules');
const Fe = require('../src/lib/features');
const { open, getSettings, DEFAULT_SETTINGS } = require('../src/db');
const { startApp, Client, miniSociety, addEvent, recomputeAll } = require('./helpers');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gs-kit-'));

// ---- config -----------------------------------------------------------------------
test('config: demo and starter configs load and validate', () => {
  for (const slug of ['demo', 'starter']) {
    const c = site.load(slug);
    assert.equal(c.slug, slug);
    assert.ok(fs.existsSync(path.join(c.dir, 'site.config.json')));
  }
  const b = site.load('demo');
  assert.equal(b.seed.type, 'custom');
  assert.ok(fs.existsSync(path.join(b.dir, 'seed', 'demo-data.json')));
  assert.ok(fs.existsSync(path.join(b.dir, b.branding.logo)));
});

test('config: Demo config reproduces the old hard-wired defaults exactly', () => {
  const s = site.toSettings(site.load('demo'));
  assert.equal(s.society_name, 'The Demo Golf Society');
  assert.equal(s.invite_code, 'CHANGEME');
  assert.equal(s.handicap_mode, 'fixed', 'Demo: fixed, admin-set handicaps');
  assert.deepEqual(JSON.parse(s.oom_default_scheme), { mode: 'score', positions: [30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1], participation: 0, bestN: 7, countback: true });
  assert.match(s.rules_text, /^Top 7 scores for final total/);
  assert.deepEqual(DEFAULT_SETTINGS, s, 'db defaults come from the site config');
  assert.equal(site.load('demo').rules.handicap.locked, true);
});

test('config: validation rejects bad configs with a clear message', () => {
  const ok = JSON.parse(JSON.stringify(site.load('starter')));
  const bad = (patch, re) => assert.throws(() => site.validate({ ...JSON.parse(JSON.stringify(ok)), ...patch }), re);
  bad({ slug: 'Bad Slug' }, /slug/);
  bad({ name: '' }, /name/);
  bad({ features: { rsvp: 'yes' } }, /true or false/);
  bad({ features: { jetpacks: true } }, /unknown feature/);
  bad({ branding: { colors: { primary: 'red' } } }, /hex colour/);
  bad({ branding: { colors: { neon: '#fff' } } }, /unknown colour/);
  bad({ rules: { handicap: { module: 'nope' } } }, /unknown handicap module/);
  bad({ rules: { scoring: { module: 'nope' } } }, /unknown scoring module/);
  bad({ seed: { type: 'magic' } }, /seed.type/);
});

test('config: theme colours become CSS variables and the logo is served', async () => {
  assert.equal(site.themeCss({ branding: { colors: { primary: '#112233', accent: '#abc' } } }), ':root{--em:#112233;--pk:#abc}');
  assert.equal(site.themeCss({ branding: {} }), '');
  const { db } = miniSociety();
  const app = await startApp(db);
  try {
    const home = await new Client(app.base).get('/');
    assert.match(home.text_, /<style>:root\{--em:#1b2a4a;--em-d:#0f1a30;--pk:#b5893b;--yl:#e6d8b8;--ink:#1a1f2b;--cream:#f4ede0;/);
    assert.match(home.text_, /--on-pk:#1a1f2b/, 'dark text on brass');
    assert.match(home.text_, /<meta name="theme-color" content="#1a1f2b"/);
    assert.match(home.text_, /<a class="brand wm" href="\/"[^>]*>\s*<span class="mark"><img src="\/site\/logo.svg" alt="The Demo">/);
    assert.equal((await fetch(app.base + '/site/logo.svg')).status, 200);
    assert.match(home.text_, /<h1 class="h1-logo"><img class="hero-logo" src="\/site\/logo.svg" alt="The Demo"/, 'logo is the hero title');
    assert.match(home.text_, /<header class="hd hd-menu hd-home">/); assert.match(home.text_, /class="burger-l" aria-hidden="true">Menu</);
    assert.match(await (await fetch(app.base + '/css/app.css')).text(), /"Bagel Fat One"/, 'original fonts kept');
    const logo = await fetch(app.base + '/site/logo.svg');
    assert.equal(logo.status, 200); assert.match(await logo.text(), /<svg/);
    assert.equal((await fetch(app.base + '/site/site.config.json')).status, 404, 'config is not public');
    assert.equal((await fetch(app.base + '/site/..%2Fseed%2Fdemo-data.json')).status, 404);
  } finally { await app.close(); }
});

// ---- feature flags -------------------------------------------------------------------
test('flags: config defaults, env override, config names map to modules', () => {
  const b = site.load('demo');
  const d = Fe.defaults(b, '');
  assert.equal(d.feature_rsvp, '0');
  for (const k of ['birdie', 'fedex', 'matchplay', 'majors', 'fame', 'awards']) assert.equal(d[`feature_${k}`], '1', k);
  assert.equal(Fe.defaults(b, 'rsvp').feature_rsvp, '1', 'env can turn a config-off flag on');
  assert.equal(Fe.defaults(b, '-awards').feature_awards, '0');
  assert.equal(Fe.defaults(b, '-awards').feature_rsvp, '0', 'env only overrides what it names');
  assert.equal(Fe.defaults({ features: { hall_of_fame: false, fedex_cup: false } }, '').feature_fame, '0');
  assert.equal(Fe.toKey('birdie_league'), 'birdie');
  assert.equal(Fe.defaults(null, '').feature_rsvp, '1', 'no site = all on (old behaviour)');
});

test('flags: a fresh database takes the site config flags; admin edits win and are audited', async () => {
  const db = open(':memory:', { site: { features: { rsvp: false, awards: false } } });
  assert.equal(getSettings(db).feature_rsvp, '0');
  assert.equal(getSettings(db).feature_awards, '0');
  const users = require('../src/lib/users');
  users.createUser(db, { name: 'Adm', email: 'adm@t.example', passwordHash: users.hashPassword('password-123'), role: 'admin' });
  require('../src/lib/baseline').seedBase(db);
  const app = await startApp(db);
  try {
    const adm = new Client(app.base); await adm.login('adm@t.example');
    assert.equal((await adm.get('/awards')).status, 404);
    const page = (await adm.get('/admin/settings')).text_;
    const form = {};
    for (const m of page.matchAll(/<input[^>]*name="([^"]+)"[^>]*value="([^"]*)"/g)) if (!/^feature_/.test(m[1])) form[m[1]] = m[2].replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    for (const m of page.matchAll(/<input[^>]*value="([^"]*)"[^>]*name="([^"]+)"/g)) if (!/^feature_/.test(m[2]) && !(m[2] in form)) form[m[2]] = m[1];
    for (const k of Fe.KEYS) if (k !== 'rsvp') form[`feature_${k}`] = '1'; // awards back on, rsvp stays off
    form.features_form = '1'; form.rules_text = 'Be nice.'; form.handicap_mode = 'society';
    const r = await adm.post('/admin/settings', form);
    assert.equal(r.status, 302, r.text_.slice(0, 300));
    assert.equal(getSettings(db).feature_awards, '1');
    assert.equal(getSettings(db).feature_rsvp, '0');
    assert.equal((await adm.get('/awards')).status, 200);
    const log = db.prepare("SELECT * FROM audit_log WHERE action='update_settings' ORDER BY id DESC").get();
    assert.match(log.detail, /feature_awards: 0 → 1/);
    assert.doesNotMatch(log.detail, /feature_rsvp/);
  } finally { await app.close(); }
});

// ---- rule modules ----------------------------------------------------------------------
test('rules: registry lists modules, unknown ids fall back to society, scoring presets', () => {
  const l = rules.list();
  assert.deepEqual(l.handicap.map((m) => m.id).sort(), ['fixed', 'society', 'whs']);
  assert.ok(l.scoring.some((m) => m.id === 'stableford-best-n'));
  assert.equal(rules.handicap('whs').id, 'whs');
  assert.equal(rules.handicap('anything-else').id, 'society');
  assert.equal(rules.scoringScheme('position-points', { participation: 2 }).participation, 2);
  assert.equal(rules.scoringScheme('stableford-best-n', { bestN: 5 }).bestN, 5);
  assert.throws(() => rules.scoringScheme('nope'), /Unknown scoring module/);
  assert.throws(() => rules.registerHandicap({ id: 'x' }), /needs onResult/);
});

test('rules: switching module changes the maths; a custom module can be plugged in', () => {
  const { db, season, course, ids } = miniSociety([20, 20, 20, 20]);
  const ev = addEvent(db, { season, course, date: '2026-04-01', status: 'completed' });
  require('../src/lib/results').saveResults(db, ev, ids.map((u, i) => ({ user_id: u, stableford: 30 + i * 3 })));
  const idx = () => ids.map((u) => db.prepare('SELECT handicap_index h FROM users WHERE id=?').get(u).h);
  const whs = idx();
  require('../src/db').setSetting(db, 'handicap_mode', 'society'); recomputeAll(db);
  const soc = idx();
  assert.notDeepEqual(whs, soc);
  assert.ok(soc[3] < 20, 'society: 39 pts is cut');
  rules.registerHandicap({ id: 'flat', label: 'Everyone off 10', usesGeneralPlay: false, options: () => ({}), context: () => null,
    onResult(st, r) { st.current = 10; st.hist.push({ effective_on: r.event_date, index_before: null, index_after: 10, source: 'event', result_id: r.id, label: 'flat' }); return { idx: 10, ch: 10, ph: 10, ags: null, stable: r.stableford_in, net: null, diff: null }; } });
  try {
    require('../src/db').setSetting(db, 'handicap_mode', 'flat'); recomputeAll(db);
    assert.deepEqual(idx(), [10, 10, 10, 10]);
  } finally { delete rules.HANDICAP.flat; }
});

// ---- scaffold ----------------------------------------------------------------------------
const { scaffold, parseArgs } = require('../scripts/new-society');
const fx = (f) => path.join(__dirname, 'fixtures', f);

test('scaffold: parses args', () => {
  const a = parseArgs(['--slug', 'x', '--name', 'X GS', '--import', 'a.csv', '--import', 'b.csv', '--set', 'features.rsvp=false', '--force']);
  assert.deepEqual(a.import, ['a.csv', 'b.csv']); assert.equal(a.force, true); assert.deepEqual(a.set, ['features.rsvp=false']);
  assert.throws(() => parseArgs(['--slug']), /needs a value/);
});

test('scaffold: CSV import -> config + seed + working database', async () => {
  const out = tmp(); const dbPath = path.join(out, 'check.db');
  const r = await scaffold({ slug: 'test-hackers', name: 'The Test Hackers Golf Society', out, import: [fx('members.csv'), fx('events.csv'), fx('results.csv')], set: ['features.rsvp=false', 'branding.colors.primary=#225588', 'rules.handicap.module=society'], db: dbPath });
  const cfg = JSON.parse(fs.readFileSync(path.join(out, 'test-hackers', 'site.config.json'), 'utf8'));
  assert.equal(cfg.name, 'The Test Hackers Golf Society');
  assert.equal(cfg.branding.short_name, 'Test Hackers');
  assert.equal(cfg.branding.colors.primary, '#225588');
  assert.equal(cfg.features.rsvp, false);
  assert.deepEqual(cfg.seed, { type: 'import', file: 'seed/import.json' });
  assert.deepEqual(r.counts, { members: 3, events: 2, results: 4 });
  const imp = JSON.parse(fs.readFileSync(path.join(out, 'test-hackers', 'seed', 'import.json'), 'utf8'));
  assert.equal(imp.members[2].name, 'Player 62');
  assert.equal(imp.events[0].date, '2026-04-12', 'UK dates normalised');
  assert.equal(r.built.people, 3); assert.equal(r.built.results, 3);
  assert.ok(r.built.warnings.some((w) => /Player 72/.test(w)), 'unknown players reported, not silently dropped');
  const D = require('better-sqlite3'); const db = new D(dbPath, { readonly: true });
  const S = Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map((x) => [x.key, x.value]));
  assert.equal(S.society_name, 'The Test Hackers Golf Society');
  assert.equal(S.feature_rsvp, '0'); assert.equal(S.handicap_mode, 'society');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 3);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM results r JOIN users u ON u.id=r.user_id WHERE u.name='Player 60' AND r.stableford=38").get().n, 1);
  assert.equal(db.prepare("SELECT status FROM events WHERE title='April Stableford'").get().status, 'completed');
  db.close();
});

test('scaffold: XLSX import', async () => {
  const ExcelJS = require('exceljs');
  const out = tmp(); const book = path.join(out, 'society.xlsx');
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Members').addRows([['Name', 'HCP'], ['Player 67', 14], ['Player 66', 6.2]]);
  wb.addWorksheet('Courses').addRows([['Name', 'Par', 'Rating', 'Slope'], ['Hilltop', 70, 69.1, 125]]);
  wb.addWorksheet('Events').addRows([['Title', 'Date', 'Venue', 'Status'], ['Opener', new Date('2026-03-07T00:00:00Z'), 'Hilltop', 'completed']]);
  wb.addWorksheet('Results').addRows([['Event', 'Player', 'Points'], ['Opener', 'Player 67', 36], ['Opener', 'Player 66', 33]]);
  wb.addWorksheet('Honours').addRows([['Trophy', 'Year', 'Player'], ['Club Champion', 2025, 'Player 66']]);
  wb.addWorksheet('Notes').addRows([['ignored']]);
  await wb.xlsx.writeFile(book);
  const r = await scaffold({ slug: 'xl-club', name: 'XL Club', out, import: [book], db: path.join(out, 'x.db') });
  assert.deepEqual(r.counts, { members: 2, courses: 1, events: 1, results: 2, honours: 1 });
  assert.equal(r.built.results, 2); assert.equal(r.built.honours, 1);
  const D = require('better-sqlite3'); const db = new D(path.join(out, 'x.db'), { readonly: true });
  assert.equal(db.prepare("SELECT slope FROM courses WHERE name='Hilltop'").get().slope, 125);
  assert.equal(db.prepare("SELECT event_date FROM events WHERE title='Opener'").get().event_date, '2026-03-07');
  db.close();
});

test('scaffold: refuses to overwrite, rejects bad input', async () => {
  const out = tmp();
  await scaffold({ slug: 'once', name: 'Once GS', out });
  await assert.rejects(scaffold({ slug: 'once', name: 'Once GS', out }), /already exists/);
  await assert.rejects(scaffold({ slug: 'Bad Slug', name: 'x', out }), /slug/);
  await assert.rejects(scaffold({ slug: 'ok', name: 'x', out, import: [path.join(out, 'missing.csv')] }), /No such file/);
  await assert.rejects(scaffold({ slug: 'ok2', name: 'x', out, set: ['features.rsvp=maybe'] }), /true or false/);
});

test('scaffold: a scaffolded site boots and shows its own branding', async () => {
  const out = tmp();
  await scaffold({ slug: 'boot-club', name: 'Boot Club', out, set: ['branding.colors.accent=#ff0000', 'features.awards=false'] });
  const cfg = JSON.parse(fs.readFileSync(path.join(out, 'boot-club', 'site.config.json'), 'utf8')); cfg.dir = path.join(out, 'boot-club');
  const db = open(':memory:', { site: cfg });
  for (const [k, v] of Object.entries(site.toSettings(cfg))) require('../src/db').setSetting(db, k, v);
  require('../src/lib/baseline').seedBase(db);
  const app = await startApp(db, { site: cfg });
  try {
    const c = new Client(app.base);
    const home = await c.get('/');
    assert.match(home.text_, /Boot Club/); assert.doesNotMatch(home.text_, /Demo/);
    assert.match(home.text_, /--pk:#ff0000/);
    assert.equal((await c.get('/awards')).status, 404);
  } finally { await app.close(); }
});
