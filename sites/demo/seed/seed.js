'use strict';
/**
 * Default seed: a fictional demo society season (made-up names and venues)
 * (sites/demo/seed/demo-data.json, generated from the .xlsx). See README "Spreadsheet import".
 * This is the Demo's bespoke seeder; new societies use the generic importer (src/seed/import.js).
 */
const { DEMO_PASSWORD } = require('../../../src/config');
const { setSetting } = require('../../../src/db');
const users = require('../../../src/lib/users');
const { recomputeAll } = require('../../../src/lib/engine');
const { saveResults } = require('../../../src/lib/results');
const rsvpLib = require('../../../src/lib/rsvp');
const { seedBase } = require('../../../src/lib/baseline');
const Soc = require('../../../src/lib/society');
const DATA = require('./demo-data.json');

// Nicknames used in the Matchplay / Euro sheets -> member names (confirmed or assumed, see README)
const ALIASES = {
  P21: 'Player 21', 'P32b': 'Player 32', 'P32c': 'Player 32', 'P32d': 'Player 32',
  P6: 'Player 6', P33b: 'Player 33', P12: 'Player 12', P17b: 'Player 17',
  P35: 'Player 35', 'P9b': 'Player 9', P10: 'Player 10',
  // confirmed by Admin (Oct 2026, Clubhouse WhatsApp list)
  P7: 'Player 7', 'P23b': 'Player 23', 'P23c': 'Player 23', P18b: 'Player 18', 'P13b': 'Player 13', P28: 'Player 28',
  P11b: 'Player 11', P3b: 'Player 3', P1b: 'Player 1',
};
const canon = (n) => { const t = String(n).replace(/\(Holder\)/i, '').trim(); return ALIASES[t] || t; };

// Demo logins attached to real members (reassign in Admin → Members)
const LOGINS = { 'Admin': ['admin@example.test', 'admin'], 'Player 1': ['captain@example.test', 'captain'], 'Player 8': ['member@example.test', 'member'] };

// 2026 DEMO MATCHPLAY, transcribed from the bracket sheet. [round, slot, p1, p2, winner(1|2|null), result]
// Left half = slots 1-8 of round 1, right half = 9-16. Winner of (r, s) meets winner of (r, s±1) in round r+1.
const MATCHPLAY = [
  [1, 1, 'Player 16', 'Player 23', 1, '2&1'], [1, 2, 'P21', 'Player 11', 2, '2 up'],
  [1, 3, 'Player 24', 'Player 4', 2, '1 up'], [1, 4, 'Player 28', 'Player 13', 2, '4&3'],
  [1, 5, 'P33b', 'Player 7', 2, null], [1, 6, 'Player 26', 'P12', 1, '1 up'],
  [1, 7, 'Player 18', 'P17b', 1, '5&4'], [1, 8, 'Player 8', 'Bye', 1, 'Bye'],
  [1, 9, 'Player 27', 'Player 1', 2, '2&1'], [1, 10, 'P6', 'Player 15', 2, '2 up'],
  [1, 11, 'Player 20', 'Player 2', 1, '2 up'], [1, 12, 'Admin', 'Player 14', 1, null],
  [1, 13, 'P35', 'P9b', 2, '7&6'], [1, 14, 'P32b', 'Player 22', 1, '4&2'],
  [1, 15, 'P10', 'Bye', 1, 'Bye'], [1, 16, 'Player 5', 'Bye', 1, 'Bye'],
  [2, 1, 'Player 16', 'Player 11', 1, '5&4'], [2, 2, 'Player 4', 'Player 13', 2, '6&5'],
  [2, 3, 'Player 7', 'Player 26', 1, '4&3'], [2, 4, 'Player 18', 'Player 8', 2, '1 up'],
  [2, 5, 'Player 1', 'Player 15', 1, 'Bye'], [2, 6, 'Player 20', 'Admin', 2, '3&2'],
  [2, 7, 'P9b', 'P32b', 1, '5&4'], [2, 8, 'P10', 'Player 5', 2, null],
  [3, 1, 'Player 16', 'Player 13', 2, '4&2'], [3, 2, 'Player 7', 'Player 8', 2, '1 up'],
  [3, 3, 'Player 1', 'Admin', 1, '1 up'], [3, 4, 'P9b', 'Player 5', 2, 'Bye'],
  [4, 1, 'Player 13', 'Player 8', 2, '4&2'], [4, 2, 'Player 1', 'Player 5', null, null],
  [5, 1, 'Player 8', null, null, null],
];

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

  // ---- members (Handicap_Records first, then anyone who only appears in other sheets)
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
    const extra = new Set();
    for (const list of [DATA.oom, DATA.birdie, DATA.fedex, DATA.major.results, DATA.euro.results]) for (const r of list) extra.add(canon(r.name));
    for (const m of MATCHPLAY) for (const n of [m[2], m[3]]) if (n && !Soc.isBye(n)) extra.add(canon(n));
    for (const n of [...extra].sort()) if (!uid[n]) mk(n, null);
  })();
  db.prepare("UPDATE users SET bio='Society admin.' WHERE id=?").run(uid['Admin']);
  log(`members: ${Object.keys(uid).length}`);

  // ---- courses / venues (par, rating and slope are placeholders: the sheet only has stableford points)
  const venueIds = {};
  const venue = (name) => venueIds[name] || (venueIds[name] = db.prepare('INSERT INTO courses(name,tee,par,rating,slope,location) VALUES (?,?,?,?,?,?)').run(name, 'Yellow', 72, 72, 113, null).lastInsertRowid);

  // ---- tournaments
  const tIns = db.prepare('INSERT INTO tournaments(season_id,name,kind,winner_cut,cut_applies,cut_note,honour_category_id) VALUES (?,?,?,?,?,?,?)');
  const major = tIns.run(season, DATA.major.name, 'major', 2, 1, DATA.major.note, cat.Major).lastInsertRowid;
  const euro = tIns.run(season, DATA.euro.name, 'euro', 1, 0, DATA.euro.note, cat['European Open']).lastInsertRowid;

  const eIns = db.prepare(`INSERT INTO events(season_id,title,course_id,event_date,tee_time,format,scoring_basis,cost_pence,capacity,notes,status,counts_handicap,counts_oom,points_multiplier,allowance_pct,honour_category_id,tournament_id,round_no)
    VALUES (?,?,?,?,?,'stableford','stableford',0,NULL,?,?,?,?,1,100,NULL,?,?)`);
  // Imported events don't re-adjust handicaps (counts_handicap=0): the sheet's current handicaps are loaded instead.
  const evId = {};
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  for (const e of DATA.events) {
    const isMajor = e.key.startsWith('maj');
    const title = isMajor ? `${DATA.major.name} — Round ${e.key === 'maj1' ? 1 : 2}` : `${MONTHS[+e.date.slice(5, 7) - 1]} Stableford — ${e.venue}`;
    evId[e.key] = eIns.run(season, title, venue(e.venue), e.date, e.time || '09:00', isMajor ? DATA.major.note : 'Monthly stableford. Order of Merit, FedEx and Birdie League event.', 'completed', 0, 1, isMajor ? major : null, isMajor ? (e.key === 'maj1' ? 1 : 2) : null).lastInsertRowid;
  }
  const euroIds = DATA.euro.rounds.map((r, i) => eIns.run(season, `${DATA.euro.name} — Round ${i + 1} (${r[1]})`, venue(r[1]), r[0], '09:00', DATA.euro.note + '. Does not count for the Order of Merit.', 'completed', 0, 0, euro, i + 1).lastInsertRowid);

  // ---- results: Order of Merit sheet (0 = did not play)
  const per = {};
  for (const row of DATA.oom) for (const [k, v] of Object.entries(row.values)) if (v > 0 && !k.startsWith('maj')) (per[k] = per[k] || []).push({ user_id: uid[canon(row.name)], stableford: v });
  // Major rounds come from the Major sheet. Deliberate correction: Player 17's round 2 is 32 on the Major
  // sheet but 0 on the OoM sheet; he played, so the 32 counts for the Order of Merit too (CORRECTIONS below).
  for (const r of DATA.major.results) {
    [['maj1', r.r1], ['maj2', r.r2]].forEach(([k, v]) => { if (v > 0) (per[k] = per[k] || []).push({ user_id: uid[canon(r.name)], stableford: v }); });
  }
  for (const [k, rows] of Object.entries(per)) saveResults(db, evId[k], rows);
  const eu = [[], []];
  for (const r of DATA.euro.results) { if (r.r1 > 0) eu[0].push({ user_id: uid[canon(r.name)], stableford: r.r1 }); if (r.r2 > 0) eu[1].push({ user_id: uid[canon(r.name)], stableford: r.r2 }); }
  eu.forEach((rows, i) => saveResults(db, euroIds[i], rows));

  // ---- Birdie League & FedEx (as entered on the sheet)
  const cIns = db.prepare('INSERT INTO comp_scores(comp,event_id,user_id,value) VALUES (?,?,?,?)');
  for (const [comp, list] of [['birdie', DATA.birdie], ['fedex', DATA.fedex]]) for (const row of list) for (const [k, v] of Object.entries(row.values)) cIns.run(comp, evId[k], uid[canon(row.name)], v);

  // ---- Matchplay bracket
  const mp = db.prepare("INSERT INTO mp_comps(season_id,name,size,notes,winner_cut,honour_category_id) VALUES (?,?,32,?,1,?)")
    .run(season, '2026 Demo Matchplay', 'Winner cut 1 shot. Any player not turning up twice for their same match will be disqualified.', cat.Matchplay).lastInsertRowid;
  const mIns = db.prepare('INSERT INTO mp_matches(comp_id,round,slot,p1_id,p1_name,p2_id,p2_name,winner,result) VALUES (?,?,?,?,?,?,?,?,?)');
  const who = (n) => (n == null ? [null, null] : Soc.isBye(n) ? [null, 'Bye'] : [uid[canon(n)] || null, canon(n)]);
  for (const m of MATCHPLAY) { const a = who(m[2]); const b = who(m[3]); mIns.run(mp, m[0], m[1], a[0], a[1], b[0], b[1], m[4], m[5]); }

  // ---- holders (last year's winners, marked "(Holder)" on the sheets)
  const hIns = db.prepare("INSERT INTO honours(category_id,year,user_id,detail,source) VALUES (?,?,?,?,'manual')");
  hIns.run(cat['Order of Merit'], 2025, uid['Player 23'], 'Holder');
  hIns.run(cat['FedEx Cup'], 2025, uid['Player 23'], 'Holder');
  hIns.run(cat['Birdie League'], 2025, uid['Player 1'], 'Holder');
  hIns.run(cat.Matchplay, 2025, uid['Player 5'], 'Holder');

  // ---- remaining 2026 dates (venues to be confirmed)
  // Nov from Admin's events app (spelt "Wouldingham" there); Dec has a column on the sheet but no venue/date yet
  const upcoming = [['November Stableford — Clubhouse', '2026-11-07', '12:00', venue('Clubhouse'), 'Monthly stableford — Order of Merit, FedEx and Birdie League event.'],
    ['December Stableford — venue TBC', '2026-12-12', '12:00', null, 'Date and venue to be confirmed.']];
  const upIds = upcoming.map((u) => eIns.run(season, u[0], u[3], u[1], u[2], u[4], 'scheduled', 1, 1, null, null).lastInsertRowid);
  for (const n of ['Admin', 'Player 1', 'Player 2', 'Player 13', 'Player 7', 'Player 31']) rsvpLib.setRsvp(db, upIds[0], uid[n], 'going');

  setSetting(db, 'est_text', 'Monthly stableford · Majors · Matchplay');
  // Features: defaults from sites/demo/site.config.json (RSVPs off); SOCIETY_FEATURES (e.g. "-rsvp,-awards") overrides.
  for (const [k, v] of Object.entries(require('../../../src/lib/features').defaults(require('../../../src/site').load('demo')))) setSetting(db, k, v);
  recomputeAll(db);
  return { people: Object.keys(uid).length, events: DATA.events.length + euroIds.length + upIds.length };
}

// Deliberate departures from the sheet's totals (agreed with Admin), used by verify-import and the tests.
const CORRECTIONS = { oom: { 'Player 17': { delta: 32, why: 'Major R2 32 counted (OoM sheet had 0; he played)' } } };

module.exports = { CORRECTIONS, seedDemo, ALIASES, MATCHPLAY, canon };
