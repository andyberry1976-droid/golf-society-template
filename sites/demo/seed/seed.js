'use strict';
/**
 * Default seed: a fictional demo society (made-up names) with members,
 * handicaps and honour categories, but no events or results.
 * Event/result data is added later in Admin, or by tests with dates relative to today.
 * New societies use the generic importer (src/seed/import.js).
 */
const { DEMO_PASSWORD } = require('../../../src/config');
const { setSetting } = require('../../../src/db');
const users = require('../../../src/lib/users');
const { recomputeAll } = require('../../../src/lib/engine');
const { seedBase } = require('../../../src/lib/baseline');
const Soc = require('../../../src/lib/society');
const DATA = require('./demo-data.json');

// Nicknames that appear on older sheets / aliases -> member names
const ALIASES = {
  P21: 'Player 21', 'P32b': 'Player 32', 'P32c': 'Player 32', 'P32d': 'Player 32',
  P6: 'Player 6', P33b: 'Player 33', P12: 'Player 12', P17b: 'Player 17',
  P35: 'Player 35', 'P9b': 'Player 9', P10: 'Player 10',
  P7: 'Player 7', 'P23b': 'Player 23', 'P23c': 'Player 23', P18b: 'Player 18', 'P13b': 'Player 13', P28: 'Player 28',
  P11b: 'Player 11', P3b: 'Player 3', P1b: 'Player 1',
};
const canon = (n) => { const t = String(n).replace(/\(Holder\)/i, '').trim(); return ALIASES[t] || t; };

// Demo logins attached to members (reassign in Admin → Members)
const LOGINS = { 'Admin': ['admin@example.test', 'admin'], 'Player 1': ['captain@example.test', 'captain'], 'Player 8': ['member@example.test', 'member'] };

function seedDemo(db, opts = {}) {
  const { log = () => {} } = opts;
  seedBase(db, { year: 2026 });
  db.prepare('DELETE FROM seasons').run();
  db.prepare('DELETE FROM honour_categories').run();
  const hash = users.hashPassword(DEMO_PASSWORD);
  const S = (k, v) => setSetting(db, k, v);
  S('handicap_mode', (opts.site || require('../../../src/site').load('demo')).rules.handicap.module || 'fixed');
  S('oom_default_scheme', JSON.stringify({ mode: 'score', positions: [30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1], participation: 0, bestN: 7, countback: true }));
  S('society_hcp', JSON.stringify(Soc.DEFAULT_SOCIETY_HCP));

  // ---- honour categories (the society's trophies)
  const catIns = db.prepare('INSERT INTO honour_categories(name,kind,sort) VALUES (?,?,?)');
  const cat = {};
  [['Order of Merit', 'oom'], ['Major', 'event'], ['European Open', 'event'], ['Matchplay', 'event'], ['FedEx Cup', 'other'], ['Birdie League', 'other']]
    .forEach((c, i) => { cat[c[0]] = catIns.run(c[0], c[1], i + 1).lastInsertRowid; });

  // ---- season
  const season = db.prepare("INSERT INTO seasons(name,year,start_date,end_date,status,scheme) VALUES ('2026',2026,'2026-01-01','2026-12-31','open',NULL)").run().lastInsertRowid;

  // ---- members (from the handicap list)
  const uid = {};
  const slug = (n) => n.toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');
  const mk = (name, h) => {
    const login = LOGINS[name];
    const id = users.createUser(db, { name, email: login ? login[0] : ('player' + String(name).replace(/^Admin$/, 'admin').replace(/^Player /, '') + '@example.test'), passwordHash: login ? hash : null, role: login ? login[1] : 'member', index: h ? h.jan : null, joinedOn: '2026-01-01' });
    if (h) {
      db.prepare('UPDATE users SET lowest_index=?, achievements=? WHERE id=?').run(h.lowest, h.ach, id);
      if (h.actual !== h.jan) db.prepare("INSERT INTO handicap_adjustments(user_id,effective_on,index_value,kind,note) VALUES (?,?,?,'manual',?)").run(id, '2026-10-04', h.actual, 'Current handicap');
    }
    uid[name] = id;
  };
  db.transaction(() => {
    for (const h of DATA.handicaps) mk(h.name, h);
  })();
  db.prepare("UPDATE users SET bio='Society admin.' WHERE id=?").run(uid['Admin']);
  log(`members: ${Object.keys(uid).length}`);

  // ---- a placeholder course so the admin can add events later
  db.prepare("INSERT INTO courses(name,tee,par,rating,slope,location) VALUES (?,?,?,?,?,?)").run('Demo Course', 'Yellow', 72, 72, 113, null);

  // ---- holders (previous year's winners)
  const hIns = db.prepare("INSERT INTO honours(category_id,year,user_id,detail,source) VALUES (?,?,?,?,'manual')");
  hIns.run(cat['Order of Merit'], 2025, uid['Player 23'], 'Holder');
  hIns.run(cat['FedEx Cup'], 2025, uid['Player 23'], 'Holder');
  hIns.run(cat['Birdie League'], 2025, uid['Player 1'], 'Holder');
  hIns.run(cat.Matchplay, 2025, uid['Player 5'], 'Holder');

  setSetting(db, 'est_text', 'Monthly stableford · Majors · Matchplay');
  // Features: defaults from sites/demo/site.config.json (RSVPs off); SOCIETY_FEATURES (e.g. "-rsvp,-awards") overrides.
  for (const [k, v] of Object.entries(require('../../../src/lib/features').defaults(require('../../../src/site').load('demo')))) setSetting(db, k, v);
  recomputeAll(db);
  return { people: Object.keys(uid).length, events: 0, season };
}

module.exports = { seedDemo, ALIASES, canon };
