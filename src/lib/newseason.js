'use strict';
// A season dropdown can offer a future year with no season yet ("new:2027"). On save, use that year's
// season if one now exists, otherwise create it (1 Jan to 31 Dec, default points scheme). Any year 1990-2100 is accepted.
function resolve(db, body, actorId) {
  const m = body && typeof body.season_id === 'string' && body.season_id.match(/^new:(\d{4})$/);
  if (!m) return;
  const year = Number(m[1]);
  if (year < 1990 || year > 2100) return;
  let s = db.prepare('SELECT id FROM seasons WHERE year=? ORDER BY id LIMIT 1').get(year);
  if (!s) {
    const name = db.prepare('SELECT 1 FROM seasons WHERE name=?').get(String(year)) ? year + ' season' : String(year);
    const id = db.prepare('INSERT INTO seasons(name,year,start_date,end_date) VALUES (?,?,?,?)').run(name, year, year + '-01-01', year + '-12-31').lastInsertRowid;
    require('./queries').audit(db, actorId, 'create_season', name + ' (from a season picker)');
    s = { id };
  }
  body.season_id = String(s.id);
}
module.exports = { resolve };
