#!/usr/bin/env node
'use strict';
/**
 * Non-interactive new-client setup. Answers come from a JSON file (see SETUP-QUESTIONS.md):
 *   npm run new-society -- --config society.json [--out ../client-golf] [--force]
 * Produces a ready-to-run copy of this app in --out (default ../<slug>-golf) with:
 *   sites/<slug>/site.config.json (name, colours, logo, features, presets, season start), optional members import,
 *   .env.example (SITE, domain, admin email; you add ADMIN_PASSWORD + SESSION_SECRET), and a built data/society.db.
 * No demo data, no shared passwords: the first admin is created from ADMIN_EMAIL + ADMIN_PASSWORD at first start.
 */
const fs = require('fs'); const path = require('path');
const ROOT = path.join(__dirname, '..');
const FEATURE_KEYS = require('../src/lib/features').KEYS;
const { PRESETS } = require('../src/lib/scoring/presets');
const HEX = /^#[0-9a-f]{6}$/i;

function validateAnswers(a) {
  const errs = [];
  if (!a.society_name) errs.push('society_name is required');
  const slug = a.slug || String(a.society_name || '').toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug)) errs.push('slug must be lowercase letters, digits or dashes');
  for (const k of ['primary', 'primary_dark', 'accent', 'highlight', 'ink', 'background']) if (a.colors && a.colors[k] && !HEX.test(a.colors[k])) errs.push(`colors.${k} must be #rrggbb`);
  if (a.admin_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(a.admin_email)) errs.push('admin_email is not an email address');
  for (const f of Object.keys(a.features || {})) if (!FEATURE_KEYS.includes(f)) errs.push(`unknown feature "${f}" (use ${FEATURE_KEYS.join(', ')})`);
  for (const p of a.competition_presets || []) if (!PRESETS[p]) errs.push(`unknown preset "${p}" (use ${Object.keys(PRESETS).join(', ')})`);
  if (a.logo && !fs.existsSync(path.resolve(a.logo))) errs.push(`logo file not found: ${a.logo}`);
  if (a.members_csv && !fs.existsSync(path.resolve(a.members_csv))) errs.push(`members_csv not found: ${a.members_csv}`);
  if (a.season_start_year && !(+a.season_start_year >= 1990 && +a.season_start_year <= 2100)) errs.push('season_start_year must be a year');
  if (a.handicap_mode && !['whs', 'society', 'fixed'].includes(a.handicap_mode)) errs.push('handicap_mode must be whs, society or fixed');
  if (errs.length) throw new Error('Setup answers are not valid:\n - ' + errs.join('\n - '));
  return slug;
}

function copyApp(out) {
  const skip = new Set(['node_modules', '.git', 'data', 'backups', 'e2e-out']);
  fs.cpSync(ROOT, out, { recursive: true, filter: (src) => {
    const rel = path.relative(ROOT, src); if (!rel) return true;
    const top = rel.split(path.sep)[0];
    if (skip.has(top)) return false;
    if (rel.startsWith(path.join('sites', 'demo'))) return false; // the fictional demo society stays behind
    return true;
  } });
}

async function setup(a, { out, force = false, buildDb = true } = {}) {
  const slug = validateAnswers(a);
  out = path.resolve(out || path.join(ROOT, '..', `${slug}-golf`));
  if (fs.existsSync(out) && !force) throw new Error(`${out} already exists (use --force)`);
  copyApp(out);
  const site = path.join(out, 'sites', slug); fs.mkdirSync(path.join(site, 'seed'), { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'sites', 'starter', 'site.config.json'), 'utf8'));
  cfg.slug = slug; cfg.name = a.society_name;
  const short = a.short_name || a.society_name.replace(/^The\s+/i, '').replace(/\s+Golf Society$/i, '');
  cfg.branding = { ...cfg.branding, short_name: short, hero_title: a.hero_title || a.society_name, tagline: a.tagline || cfg.branding.tagline,
    footer_blurb: a.footer_blurb || a.society_name, join_blurb: a.join_blurb || cfg.branding.join_blurb, colors: { ...cfg.branding.colors, ...(a.colors || {}) }, theme_color: (a.colors && (a.colors.primary_dark || a.colors.primary)) || cfg.branding.theme_color, logo: null };
  if (a.logo) { const name = 'logo' + path.extname(a.logo).toLowerCase(); fs.copyFileSync(path.resolve(a.logo), path.join(site, name)); cfg.branding.logo = name; }
  cfg.settings = { ...cfg.settings, currency: a.currency || cfg.settings.currency, contact_email: a.contact_email || '', invite_code: a.invite_code || require('crypto').randomBytes(4).toString('hex').toUpperCase(), members_only: !!a.members_only };
  if (a.admin_only_login != null) cfg.auth = { admin_only: !!a.admin_only_login };
  cfg.features = { ...Object.fromEntries(FEATURE_KEYS.map((k) => [k, true])), ...(a.features || {}) };
  if (a.handicap_mode) cfg.rules = { ...cfg.rules, handicap: { ...(cfg.rules && cfg.rules.handicap), module: a.handicap_mode } };
  cfg.competition_presets = a.competition_presets || ['stableford', 'medal_net', 'texas_scramble', 'better_ball', 'matchplay'];
  cfg.season_start_year = +a.season_start_year || new Date().getFullYear();
  cfg.seed = { type: 'none' };
  if (a.members_csv) {
    const data = await require('../src/seed/spreadsheet').readInputs([path.resolve(a.members_csv)]);
    fs.writeFileSync(path.join(site, 'seed', 'import.json'), JSON.stringify(data, null, 2) + '\n'); cfg.seed = { type: 'import', file: 'seed/import.json' };
  }
  require('../src/site').validate({ ...cfg }, 'new site config');
  fs.writeFileSync(path.join(site, 'site.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  fs.writeFileSync(path.join(out, '.env.example'), [
    `# ${a.society_name} — copy to .env (or set these on the host). Never commit real secrets.`,
    `SITE=${slug}`, 'NODE_ENV=production', `PUBLIC_URL=${a.domain ? 'https://' + a.domain.replace(/^https?:\/\//, '') : ''}`,
    `ADMIN_EMAIL=${a.admin_email || ''}`, `ADMIN_NAME=${a.admin_name || 'Society Admin'}`,
    'ADMIN_PASSWORD=   # REQUIRED on first start: a new, unique password (10+ chars). Demo passwords are refused.',
    'SESSION_SECRET=   # REQUIRED: openssl rand -hex 32', 'DATABASE_PATH=data/society.db', ''].join('\n'));
  fs.writeFileSync(path.join(out, 'SOCIETY.md'), `# ${a.society_name}\n\nGenerated by \`npm run new-society\` on ${new Date().toISOString().slice(0, 10)} from the golf society template.\n\n- Site config: \`sites/${slug}/site.config.json\`\n- Domain: ${a.domain || '(not set)'}\n- Admin email: ${a.admin_email || '(set ADMIN_EMAIL)'}\n\nStart: \`npm install && cp .env.example .env\` (fill ADMIN_PASSWORD and SESSION_SECRET), then \`npm start\`.\n`);
  let built = null;
  if (buildDb) {
    const dbFile = path.join(out, 'data', 'society.db'); fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    const S = require('../src/site'); const loaded = S.validate({ ...JSON.parse(fs.readFileSync(path.join(site, 'site.config.json'), 'utf8')), dir: site });
    const D = require('../src/db'); const db = D.open(dbFile, { site: loaded });
    for (const [k, v] of Object.entries(S.toSettings(loaded))) D.setSetting(db, k, v);
    built = require('../src/seed').seedSite(db, loaded) || {};
    built.competition_types = db.prepare('SELECT COUNT(*) n FROM competition_types').get().n;
    built.seasons = db.prepare('SELECT COUNT(*) n FROM seasons').get().n;
    built.members = db.prepare('SELECT COUNT(*) n FROM users').get().n;
    db.close();
  }
  return { out, slug, built };
}
module.exports = { setup, validateAnswers };

if (require.main === module) {
  const args = process.argv.slice(2); const get = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const file = get('--config'); if (!file) { console.error('Usage: npm run new-society -- --config society.json [--out DIR] [--force]'); process.exit(2); }
  setup(JSON.parse(fs.readFileSync(file, 'utf8')), { out: get('--out'), force: args.includes('--force') })
    .then((r) => console.log(`Ready: ${r.out}\n  site: ${r.slug}\n  ${JSON.stringify(r.built)}\nNext: cd ${r.out} && npm install && cp .env.example .env (set ADMIN_PASSWORD, SESSION_SECRET) && npm start`))
    .catch((e) => { console.error(e.message); process.exit(1); });
}
