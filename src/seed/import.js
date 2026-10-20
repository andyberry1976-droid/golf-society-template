'use strict';
/**
 * Generic importer: loads a society's normalised import data (seed/import.json, produced by
 * scripts/new-society.js from CSV/XLSX) into an EMPTY database.
 * Shape: { members:[{name,email?,handicap?,nickname?,role?,joined_on?}], courses:[{name,tee?,par,rating?,slope?,location?}],
 *          events:[{key?,title,date,course?,tee_time?,status?,counts_handicap?,counts_oom?}],
 *          results:[{event,player,stableford?,gross?,position?}], honours:[{category,year,player?,detail?}] }
 */
const users = require('../lib/users');
const { saveResults } = require('../lib/results');
const { seedBase } = require('../lib/baseline');
const { recomputeAll } = require('../lib/engine');
const { setSetting } = require('../db');

const slugify = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.|\.$/g, '');

function applyImport(db, data, { site = null, year = null } = {}) {
  if (db.prepare('SELECT COUNT(*) n FROM users').get().n > 0) throw new Error('applyImport needs an empty database');
  const D = { members: [], courses: [], events: [], results: [], honours: [], ...data };
  const years = D.events.map((e) => +String(e.date).slice(0, 4)).filter(Boolean);
  const Y = year || (years.length ? Math.max(...years) : new Date().getFullYear());
  seedBase(db, { year: Y });
  if (site) for (const [k, v] of Object.entries(require('../lib/features').defaults(site))) setSetting(db, k, v);
  const seasonFor = new Map(db.prepare('SELECT id, year FROM seasons').all().map((s) => [s.year, s.id]));
  const season = (y) => {
    if (!seasonFor.has(y)) seasonFor.set(y, db.prepare('INSERT INTO seasons(name,year,start_date,end_date,status) VALUES (?,?,?,?,?)').run(String(y), y, `${y}-01-01`, `${y}-12-31`, y < Y ? 'closed' : 'open').lastInsertRowid);
    return seasonFor.get(y);
  };
  const uid = {};
  const byName = (n) => uid[String(n || '').trim().toLowerCase()];
  const stats = { people: 0, courses: 0, events: 0, results: 0, honours: 0, warnings: [] };
  db.transaction(() => {
    for (const m of D.members) {
      if (!m.name) continue;
      const key = m.name.trim().toLowerCase();
      if (uid[key]) { stats.warnings.push(`duplicate member ${m.name}`); continue; }
      uid[key] = users.createUser(db, { name: m.name.trim(), email: (m.email || `${slugify(m.name)}@members.invalid`).toLowerCase(), role: ['admin', 'captain'].includes(m.role) ? m.role : 'member', index: m.handicap != null && m.handicap !== '' ? Number(m.handicap) : null, nickname: m.nickname || null, joinedOn: m.joined_on || `${Y}-01-01` });
      stats.people++;
    }
  })();
  const cid = {};
  for (const c of D.courses) {
    if (!c.name) continue;
    cid[c.name.trim().toLowerCase()] = db.prepare('INSERT INTO courses(name,tee,par,rating,slope,location) VALUES (?,?,?,?,?,?)')
      .run(c.name.trim(), c.tee || 'Yellow', Number(c.par) || 72, Number(c.rating) || Number(c.par) || 72, Number(c.slope) || 113, c.location || null).lastInsertRowid;
    stats.courses++;
  }
  const course = (n) => {
    if (!n) return null; const k = String(n).trim().toLowerCase();
    if (!cid[k]) { cid[k] = db.prepare("INSERT INTO courses(name,tee,par,rating,slope) VALUES (?,'Yellow',72,72,113)").run(String(n).trim()).lastInsertRowid; stats.courses++; }
    return cid[k];
  };
  const eid = {};
  for (const e of D.events) {
    if (!e.title || !e.date) { stats.warnings.push(`event without title/date skipped`); continue; }
    const y = +String(e.date).slice(0, 4);
    const id = db.prepare(`INSERT INTO events(season_id,title,course_id,event_date,tee_time,status,counts_handicap,counts_oom) VALUES (?,?,?,?,?,?,?,?)`)
      .run(season(y), e.title, course(e.course), e.date, e.tee_time || '09:00', e.status || 'scheduled', e.counts_handicap === false ? 0 : 1, e.counts_oom === false ? 0 : 1).lastInsertRowid;
    for (const k of [e.key, e.title, e.date].filter(Boolean)) eid[String(k).trim().toLowerCase()] = eid[String(k).trim().toLowerCase()] || id;
    stats.events++;
  }
  const per = new Map();
  for (const r of D.results) {
    const e = eid[String(r.event || '').trim().toLowerCase()]; const u = byName(r.player);
    if (!e || !u) { stats.warnings.push(`result skipped (unknown ${!e ? 'event' : 'player'}): ${r.event} / ${r.player}`); continue; }
    if (!per.has(e)) per.set(e, []);
    per.get(e).push({ user_id: u, stableford: r.stableford, gross: r.gross, position: r.position });
  }
  for (const [e, rows] of per) stats.results += saveResults(db, e, rows).saved;
  const cats = {};
  for (const h of D.honours) {
    if (!h.category || !h.year) continue;
    const k = h.category.trim();
    cats[k] = cats[k] || (db.prepare('SELECT id FROM honour_categories WHERE name=?').get(k) || {}).id
      || db.prepare("INSERT INTO honour_categories(name,kind,sort) VALUES (?,'event',99)").run(k).lastInsertRowid;
    db.prepare("INSERT INTO honours(category_id,year,user_id,detail,source) VALUES (?,?,?,?,'manual')").run(cats[k], Number(h.year), byName(h.player) || null, h.detail || (byName(h.player) ? null : h.player || null));
    stats.honours++;
  }
  recomputeAll(db);
  return stats;
}

module.exports = { applyImport };
