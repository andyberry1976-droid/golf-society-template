#!/usr/bin/env node
'use strict';
/**
 * Scaffold a new society site from a config + spreadsheet import.
 *
 *   node scripts/new-society.js --slug fairway-flamingos --name "The Fairway Flamingos" \
 *        [--from starter|<slug>|path/to/site.config.json] [--import book.xlsx | --import members.csv --import results.csv …]
 *        [--set branding.colors.primary=#225588 --set features.rsvp=false …] [--out sites] [--db /tmp/check.db] [--force]
 *
 * Writes sites/<slug>/site.config.json (+ seed/import.json from the spreadsheet), validates the config and,
 * with --db, builds a SQLite database from it so you can preview the site:  SITE=<slug> DATABASE_PATH=… npm start
 */
const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const a = { import: [], set: [] };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) throw new Error(`Unexpected argument ${k}`);
    const name = k.slice(2);
    if (name === 'force' || name === 'help') { a[name] = true; continue; }
    const v = argv[++i];
    if (v === undefined) throw new Error(`${k} needs a value`);
    if (name === 'import' || name === 'set') a[name].push(v); else a[name] = v;
  }
  return a;
}

function setPath(obj, dotted, raw) {
  const keys = dotted.split('.'); let o = obj;
  for (const k of keys.slice(0, -1)) { if (typeof o[k] !== 'object' || o[k] === null) o[k] = {}; o = o[k]; }
  let v = raw;
  if (/^(true|false)$/.test(raw)) v = raw === 'true'; else if (/^-?\d+(\.\d+)?$/.test(raw)) v = Number(raw);
  o[keys[keys.length - 1]] = v;
}

async function scaffold(opts) {
  const site = require('../src/site');
  if (!opts.slug || !opts.name) throw new Error('--slug and --name are required');
  const outRoot = path.resolve(opts.out || site.SITES_DIR);
  const dir = path.join(outRoot, opts.slug);
  if (fs.existsSync(dir) && !opts.force) throw new Error(`${dir} already exists (use --force to overwrite its config/import)`);
  const from = opts.from || 'starter';
  const baseFile = /\.json$/.test(from) ? path.resolve(from) : path.join(site.SITES_DIR, from, 'site.config.json');
  const cfg = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
  cfg.slug = opts.slug; cfg.name = opts.name;
  cfg.branding = { ...(cfg.branding || {}), short_name: opts.short || opts.name.replace(/^The\s+/i, '').replace(/\s+Golf Society$/i, ''), hero_title: opts.name };
  if (from !== 'starter' && cfg.branding.logo && !opts.force) cfg.branding.logo = null; // don't inherit another society's logo
  cfg.seed = { type: 'none' };
  for (const s of opts.set || []) { const i = s.indexOf('='); if (i < 1) throw new Error(`--set needs key=value: ${s}`); setPath(cfg, s.slice(0, i), s.slice(i + 1)); }
  let data = null;
  if (opts.import && opts.import.length) {
    data = await require('../src/seed/spreadsheet').readInputs(opts.import);
    cfg.seed = { type: 'import', file: 'seed/import.json' };
  }
  site.validate(cfg, 'new site config');
  fs.mkdirSync(path.join(dir, 'seed'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'site.config.json'), JSON.stringify(cfg, null, 2) + '\n');
  if (data) fs.writeFileSync(path.join(dir, 'seed', 'import.json'), JSON.stringify(data, null, 2) + '\n');
  const counts = data ? Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])) : {};
  let built = null;
  if (opts.db) {
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(opts.db + ext, { force: true });
    site.load.clearCache();
    const loaded = (() => { const c = JSON.parse(fs.readFileSync(path.join(dir, 'site.config.json'), 'utf8')); c.dir = dir; return site.validate(c); })();
    const db = require('../src/db').open(opts.db, { site: loaded });
    for (const [k, v] of Object.entries(site.toSettings(loaded))) require('../src/db').setSetting(db, k, v);
    built = require('../src/seed').seedSite(db, loaded) || { people: 0 };
    if (!built.events) require('../src/lib/baseline').seedBase(db);
    db.close();
  }
  return { dir, config: cfg, counts, built };
}

module.exports = { scaffold, parseArgs, setPath };

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
  scaffold(opts).then((r) => {
    console.log(`Created ${path.relative(process.cwd(), r.dir)}/site.config.json`);
    if (Object.keys(r.counts).length) console.log(`Imported: ${Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
    if (r.built) { console.log(`Built ${opts.db}: ${r.built.people} members, ${r.built.events || 0} events, ${r.built.results || 0} results`); for (const w of r.built.warnings || []) console.log('  ! ' + w); }
    console.log(`Preview:  SITE=${r.config.slug}${opts.out ? ` SITE_DIR=${r.dir}` : ''} DATABASE_PATH=${opts.db || `data/${r.config.slug}.db`} npm start`);
  }).catch((e) => { console.error('new-society: ' + e.message); process.exit(1); });
}
