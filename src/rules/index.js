'use strict';
/**
 * Pluggable rule modules. A society picks one handicap module and one scoring module in its config;
 * admins can switch the handicap module in Admin → Settings (setting `handicap_mode`).
 * Add a module: drop a file in rules/handicap/ (or a preset in rules/scoring/) and register it here.
 */
const HANDICAP = { fixed: require('./handicap/fixed'), society: require('./handicap/society'), whs: require('./handicap/whs') };
const SCORING = require('./scoring/presets');

function handicap(id) {
  // historic behaviour: anything that isn't 'whs' is the society engine
  return HANDICAP[id] || HANDICAP.society;
}
function registerHandicap(mod) {
  for (const k of ['id', 'onResult', 'context']) if (!mod || !mod[k]) throw new Error(`Handicap module needs ${k}`);
  HANDICAP[mod.id] = mod;
}
function scoringScheme(id, options) {
  const m = SCORING[id];
  if (!m) throw new Error(`Unknown scoring module "${id}" (have: ${Object.keys(SCORING).join(', ')})`);
  return m.scheme(options || {});
}
const list = () => ({ handicap: Object.values(HANDICAP).map((m) => ({ id: m.id, label: m.label })), scoring: Object.entries(SCORING).map(([id, m]) => ({ id, label: m.label })) });

module.exports = { handicap, registerHandicap, scoringScheme, list, HANDICAP, SCORING };
