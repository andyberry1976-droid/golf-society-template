'use strict';
/** Seed an empty database for a site, as its config says (seed.type: none | custom | import). */
const path = require('path');

function seedSite(db, site) {
  const seed = site.seed || { type: 'none' };
  if (seed.type === 'none') return null;
  if (seed.type === 'custom') {
    const mod = require(path.join(site.dir, seed.script || 'seed/seed.js'));
    const fn = mod.seed || mod.seedDemo || mod;
    return fn(db, { site });
  }
  if (seed.type === 'import') {
    const data = require(path.join(site.dir, seed.file || 'seed/import.json'));
    return require('./import').applyImport(db, data, { site });
  }
  throw new Error(`Unknown seed type ${seed.type}`);
}

module.exports = { seedSite };
