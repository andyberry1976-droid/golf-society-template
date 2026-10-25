'use strict';
/**
 * Site config: everything that makes one society's build bespoke lives in sites/<slug>/:
 *   site.config.json  name, branding (text, colours, logo), default settings, feature-flag defaults,
 *                     rule modules (handicap + scoring) and how to seed;
 *   seed/             that society's seed data (and, optionally, a bespoke seed script);
 *   logo.svg etc.     static assets, served at /site/<file>.
 * Pick the site with SITE=<slug> (default: demo) or SITE_DIR=/abs/path.
 */
const fs = require('fs');
const path = require('path');

const SITES_DIR = path.join(__dirname, '..', 'sites');
const FEATURE_NAMES = ['rsvp', 'birdie_league', 'fedex_cup', 'matchplay', 'majors', 'hall_of_fame', 'awards'];
const COLOR_VARS = {
  primary: '--em', primary_dark: '--em-d', accent: '--pk', highlight: '--yl', ink: '--ink', background: '--cream',
  // optional finer colour controls (defaults in app.css match the original look)
  primary_deep: '--em-dd', accent_dark: '--pk-d', accent_light: '--pk-l', accent_text: '--pk-t', on_accent: '--on-pk', accent_bright: '--pk-x',
  muted: '--mute', line: '--line', zebra: '--zebra', header: '--hd-bg', hero_from: '--hero-a', hero_to: '--hero-b',
  faint: '--faint', hero_glow: '--glow-pk', hero_glow_2: '--glow-pk2', hero_glow_highlight: '--glow-yl', soft_text: '--soft', focus: '--vi',
};
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

class ConfigError extends Error {}

function validate(c, where = 'site config') {
  const err = (m) => { throw new ConfigError(`${where}: ${m}`); };
  if (!c || typeof c !== 'object') err('not an object');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(c.slug || '')) err('slug must be lowercase letters, digits or dashes');
  if (!c.name || typeof c.name !== 'string') err('name is required');
  const b = c.branding || {};
  for (const [k, v] of Object.entries(b.colors || {})) {
    if (!COLOR_VARS[k]) err(`unknown colour "${k}" (use ${Object.keys(COLOR_VARS).join(', ')})`);
    if (!HEX.test(v)) err(`colour ${k} must be a hex colour like #0a7a55`);
  }
  for (const [k, v] of Object.entries(c.features || {})) {
    if (!FEATURE_NAMES.includes(k) && !require('./lib/features').KEYS.includes(k)) err(`unknown feature "${k}"`);
    if (typeof v !== 'boolean') err(`feature ${k} must be true or false`);
  }
  const rules = require('./rules');
  const hm = (c.rules && c.rules.handicap && c.rules.handicap.module) || 'society';
  if (!rules.HANDICAP[hm]) err(`unknown handicap module "${hm}" (have: ${Object.keys(rules.HANDICAP).join(', ')})`);
  const sm = (c.rules && c.rules.scoring && c.rules.scoring.module) || 'stableford-best-n';
  if (!rules.SCORING[sm]) err(`unknown scoring module "${sm}" (have: ${Object.keys(rules.SCORING).join(', ')})`);
  const seed = c.seed || { type: 'none' };
  if (!['none', 'custom', 'import'].includes(seed.type)) err('seed.type must be none, custom or import');
  return c;
}

function dirFor(slug) {
  if (process.env.SITE_DIR && !slug) return path.resolve(process.env.SITE_DIR);
  return path.join(SITES_DIR, slug || process.env.SITE || 'demo');
}

const cache = new Map();
function load(slug) {
  const dir = dirFor(slug);
  if (cache.has(dir)) return cache.get(dir);
  const file = path.join(dir, 'site.config.json');
  if (!fs.existsSync(file)) throw new ConfigError(`No site config at ${file}`);
  const c = validate(JSON.parse(fs.readFileSync(file, 'utf8')), file);
  c.dir = dir;
  cache.set(dir, c);
  return c;
}
load.clearCache = () => cache.clear();

const b01 = (v) => (v ? '1' : '0');

/** The settings rows a fresh database gets from this config (feature switches are separate, see features.defaults). */
function toSettings(c) {
  const b = c.branding || {}; const s = c.settings || {}; const h = (c.rules && c.rules.handicap) || {}; const sc = (c.rules && c.rules.scoring) || {};
  const rules = require('./rules');
  const out = {
    society_name: c.name,
    short_name: b.short_name || c.name,
    hero_title: b.hero_title || b.short_name || c.name,
    hero_ribbon: b.hero_ribbon || 'Golf Society',
    est_text: b.est_text || '',
    tagline: b.tagline || '',
    footer_blurb: b.footer_blurb || c.name,
    join_blurb: b.join_blurb || '',
    currency: s.currency || '£',
    contact_email: s.contact_email || '',
    invite_code: s.invite_code || '',
    invite_auto_approve: b01(s.invite_auto_approve),
    members_only: b01(s.members_only),
    default_allowance: String(h.default_allowance ?? 95),
    max_index: String(h.max_index ?? 54),
    soft_cap: b01(h.soft_cap ?? true),
    hard_cap: b01(h.hard_cap ?? true),
    default_start_index: String(h.default_start_index ?? 28),
    oom_default_scheme: JSON.stringify(rules.scoringScheme(sc.module || 'stableford-best-n', sc.options)),
    handicap_mode: h.module || 'society',
    society_hcp: JSON.stringify({ ...require('./lib/society').DEFAULT_SOCIETY_HCP, ...(h.options || {}) }),
    rules_text: ((c.rules && c.rules.text) || []).join('\n'),
  };
  return out;
}

/** CSS custom-property overrides for the theme colours (empty string when none). */
function themeCss(c) {
  const cols = (c && c.branding && c.branding.colors) || {};
  const decl = Object.entries(cols).filter(([k, v]) => COLOR_VARS[k] && HEX.test(v)).map(([k, v]) => `${COLOR_VARS[k]}:${v}`).join(';');
  let extra = '';
  try { if (c && c.dir) { const f = path.join(c.dir, 'theme.css'); if (fs.existsSync(f)) extra = fs.readFileSync(f, 'utf8').replace(/<\/style/gi, ''); } } catch (_) { /* optional per-site stylesheet */ }
  return (decl ? `:root{${decl}}` : '') + extra;
}

module.exports = { load, validate, toSettings, themeCss, dirFor, SITES_DIR, FEATURE_NAMES, COLOR_VARS, ConfigError };
