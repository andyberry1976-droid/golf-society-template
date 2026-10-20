'use strict';
/**
 * Applies the setup answers stored in a site config on a fresh database (idempotent):
 *   competition_presets: ["stableford", "texas_scramble", ...] -> competition types (only while none exist)
 *   season_start_year: 2026 -> open seasons from that year to this year (only when the database has no seasons yet... or missing years)
 */
const { PRESETS, normalise } = require('./scoring/presets');
function apply(db, site) {
  if (!site) return;
  const presets = Array.isArray(site.competition_presets) ? site.competition_presets.filter((k) => PRESETS[k]) : [];
  if (presets.length && !db.prepare('SELECT 1 FROM competition_types').get()) {
    const ins = db.prepare('INSERT INTO competition_types(society_id,name,config) VALUES (1,?,?)');
    for (const k of presets) ins.run(PRESETS[k].label, JSON.stringify(normalise({ ...PRESETS[k], preset: k })));
  }
  const y0 = parseInt(site.season_start_year, 10);
  if (y0 >= 1990 && y0 <= 2100 && db.prepare("SELECT 1 FROM sqlite_master WHERE name='seasons'").get()) {
    const now = new Date().getFullYear();
    const ins = db.prepare('INSERT INTO seasons(name,year,start_date,end_date,status) VALUES (?,?,?,?,?)');
    for (let y = y0; y <= Math.max(y0, now); y++) if (!db.prepare('SELECT 1 FROM seasons WHERE year=?').get(y)) ins.run(String(y), y, `${y}-01-01`, `${y}-12-31`, y < now ? 'closed' : 'open');
  }
}
module.exports = { apply };
