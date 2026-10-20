#!/usr/bin/env node
'use strict';
/** Fill an EMPTY database with a clearly fake demo society. Refuses to touch a database that already has members. */
const { open, setSetting } = require('../src/db'); const { PRESETS, normalise } = require('../src/lib/scoring/presets'); const { computeEvent } = require('../src/lib/compute');
function seedDemo(db) {
  if (db.prepare('SELECT 1 FROM members').get()) throw new Error('Database already has members; demo seed only runs on an empty database.');
  setSetting(db, 'name', 'Demo Golf Society (sample data)'); setSetting(db, 'tagline', 'Made-up players and scores for showing the site');
  const names = ['Player 85', 'Player 78', 'Player 79', 'Player 80', 'Player 81', 'Player 82', 'Player 83', 'Player 84'];
  const ids = names.map((n, i) => db.prepare('INSERT INTO members(name,handicap_index) VALUES (?,?)').run(n, [6.2, 11.4, 14.8, 18.1, 21.5, 9.7, 24.3, 16.0][i]).lastInsertRowid);
  const pars = [4, 4, 3, 5, 4, 4, 3, 4, 5, 4, 3, 4, 5, 4, 4, 3, 4, 5]; const sis = [7, 11, 15, 1, 9, 3, 17, 13, 5, 8, 16, 2, 6, 12, 4, 18, 14, 10];
  const course = db.prepare('INSERT INTO courses(name,par,rating,slope,holes) VALUES (?,?,?,?,?)').run('Example Park (fictional)', 72, 71.2, 128, JSON.stringify(pars.map((p, i) => ({ par: p, si: sis[i] })))).lastInsertRowid;
  const type = (k, name) => db.prepare('INSERT INTO competition_types(name,config) VALUES (?,?)').run(name, JSON.stringify(normalise({ ...PRESETS[k], preset: k }))).lastInsertRowid;
  const stb = type('stableford', 'Monthly Stableford'); const scr = type('texas_scramble', 'Texas Scramble'); type('medal_net', 'Monthly Medal'); type('matchplay', 'Matchplay');
  db.prepare('INSERT INTO leagues(name,config) VALUES (?,?)').run('Order of Merit (demo)', JSON.stringify({ types: null, events: null, bestN: null }));
  let seed = 7; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
  const ev1 = db.prepare('INSERT INTO events(title,event_date,course_id,competition_type_id) VALUES (?,?,?,?)').run('Spring Stableford', '2026-04-11', course, stb).lastInsertRowid;
  ids.forEach((m) => db.prepare('INSERT INTO scores(event_id,member_id,holes) VALUES (?,?,?)').run(ev1, m, JSON.stringify(pars.map((p) => p + Math.floor(rnd() * 3)))));
  computeEvent(db, ev1);
  const ev2 = db.prepare('INSERT INTO events(title,event_date,course_id,competition_type_id) VALUES (?,?,?,?)').run('Summer Scramble', '2026-06-20', course, scr).lastInsertRowid;
  ids.forEach((m, i) => db.prepare('INSERT INTO scores(event_id,member_id,team_no,gross_total) VALUES (?,?,?,?)').run(ev2, m, (i % 2) + 1, i < 2 ? [64, 66][i] : null));
  computeEvent(db, ev2);
  db.prepare('INSERT INTO events(title,event_date,course_id,competition_type_id) VALUES (?,?,?,?)').run('Autumn Medal', '2026-11-14', course, stb + 2);
  return { ids, course };
}
if (require.main === module) { const db = open(process.env.DATABASE_PATH || 'data/society.db'); seedDemo(db); console.log('Demo society seeded.'); }
module.exports = { seedDemo };
