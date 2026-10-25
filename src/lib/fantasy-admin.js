'use strict';
/**
 * Fantasy League admin tools: add golfers to the pickable pool (with a price) and enter a manager's team on their behalf.
 * Same rules as the published Fantasy League: a squad of R.squad golfers, total cost within £R.budget m, one captain
 * (scores double), no free transfer (a team, once entered, is only changed by an admin deleting and re-entering it).
 */
const norm = (s) => String(s || '').trim().replace(/\s+/g, ' ');
const key = (s) => norm(s).toLowerCase();

/** The pickable pool for a season: the price list (file or live) plus golfers an admin added. */
function pool(db, season, base) {
  const out = []; const seen = new Set();
  for (const p of (base && base.players) || []) { if (seen.has(key(p.name))) continue; seen.add(key(p.name)); out.push({ name: p.name, user_id: p.user_id || null, price: +p.price, source: 'list' }); }
  for (const p of db.prepare('SELECT * FROM fantasy_pool WHERE season=? ORDER BY id').all(season)) {
    if (seen.has(key(p.name))) continue; seen.add(key(p.name)); out.push({ id: p.id, name: p.name, user_id: p.user_id, price: p.price, source: 'admin' });
  }
  return out.sort((a, b) => b.price - a.price || a.name.localeCompare(b.name));
}

function teams(db, season) {
  return db.prepare('SELECT * FROM fantasy_teams WHERE season=? ORDER BY team_name COLLATE NOCASE').all(season).map((t) => {
    const picks = JSON.parse(t.picks); return { ...t, picks, cost: Math.round(picks.reduce((s, p) => s + p.price, 0) * 10) / 10 };
  });
}

/** Add a golfer to the pool. Returns { ok, errors, values, row }. */
function addPlayer(db, season, body, base, by = null) {
  const errors = {}; const values = { name: norm(body.name), user_id: String(body.user_id || '').trim(), price: String(body.price ?? '').trim() };
  let uid = null; let name = values.name;
  if (values.user_id) {
    uid = Number(values.user_id); const u = Number.isInteger(uid) && uid > 0 ? db.prepare('SELECT id, name FROM users WHERE id=?').get(uid) : null;
    if (!u) errors.user_id = 'Pick a member from the list'; else if (!name) name = u.name;
  }
  if (!name || name.length < 2 || name.length > 60) errors.name = 'Name must be 2–60 characters (or pick a member)';
  const price = Number(values.price);
  if (values.price === '' || !Number.isFinite(price) || price < 0.5 || price > 25 || Math.round(price * 2) !== price * 2) errors.price = 'Price must be between £0.5m and £25m, in £0.5m steps';
  if (!errors.name && pool(db, season, base).some((p) => key(p.name) === key(name) || (uid && p.user_id === uid))) errors.name = `${name} is already in the player pool`;
  if (Object.keys(errors).length) return { ok: false, errors, values };
  const info = db.prepare('INSERT INTO fantasy_pool(season,user_id,name,price,created_by) VALUES (?,?,?,?,?)').run(season, uid, name, price, by);
  return { ok: true, row: { id: info.lastInsertRowid, name, price, user_id: uid } };
}

/** Remove an admin-added golfer (refused while a team has picked them). */
function removePlayer(db, season, id) {
  const p = db.prepare('SELECT * FROM fantasy_pool WHERE id=? AND season=?').get(id, season);
  if (!p) return { ok: false, error: 'No such added player.' };
  if (teams(db, season).some((t) => t.picks.some((x) => key(x.name) === key(p.name)))) return { ok: false, error: `${p.name} is in a team — remove that team first.` };
  db.prepare('DELETE FROM fantasy_pool WHERE id=?').run(id);
  return { ok: true, row: p };
}

/** Enter a team on a manager's behalf. body: manager_name, team_name, user_id (optional), picks (names), captain. */
function addTeam(db, season, body, base, R, by = null) {
  const errors = {};
  const arr = (v) => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v]).map(norm).filter(Boolean);
  const values = { manager_name: norm(body.manager_name), team_name: norm(body.team_name), user_id: String(body.user_id || '').trim(), picks: arr(body.picks), captain: norm(body.captain) };
  values.slots = (Array.isArray(body.picks) ? body.picks : body.picks == null ? [] : [body.picks]).map(norm);
  let uid = null;
  if (values.user_id) {
    uid = Number(values.user_id); const u = Number.isInteger(uid) && uid > 0 ? db.prepare('SELECT id, name FROM users WHERE id=?').get(uid) : null;
    if (!u) errors.user_id = 'Pick a member from the list'; else if (!values.manager_name) values.manager_name = u.name;
  }
  if (values.manager_name.length < 2 || values.manager_name.length > 60) errors.manager_name = 'Manager name must be 2–60 characters (or pick a member)';
  if (values.team_name.length < 2 || values.team_name.length > 40) errors.team_name = 'Team name must be 2–40 characters';
  else if (db.prepare('SELECT 1 FROM fantasy_teams WHERE season=? AND team_name=? COLLATE NOCASE').get(season, values.team_name)) errors.team_name = 'That team name is taken';
  if (!errors.user_id && uid && db.prepare('SELECT 1 FROM fantasy_teams WHERE season=? AND user_id=?').get(season, uid)) errors.user_id = 'That member already has a team';
  const P = pool(db, season, base); const byName = new Map(P.map((p) => [key(p.name), p]));
  const picks = [];
  for (const n of values.picks) { const p = byName.get(key(n)); if (!p) { errors.picks = `${n} isn’t in the player pool`; break; } if (picks.some((x) => x.name === p.name)) { errors.picks = `${p.name} is picked twice`; break; } picks.push({ name: p.name, user_id: p.user_id || null, price: p.price }); }
  if (!errors.picks && picks.length !== R.squad) errors.picks = `Pick exactly ${R.squad} players (you picked ${picks.length})`;
  const cost = Math.round(picks.reduce((s, p) => s + p.price, 0) * 10) / 10;
  if (!errors.picks && cost > R.budget) errors.picks = `That squad costs £${cost}m — over the £${R.budget}m budget`;
  const cap = picks.find((p) => key(p.name) === key(values.captain));
  if (!values.captain) errors.captain = `Pick a captain: choose one of your ${R.squad} players (they score double)`;
  else if (!cap) errors.captain = `Pick a captain from the squad: ${values.captain} isn’t one of your ${R.squad} players`;
  if (Object.keys(errors).length) return { ok: false, errors, values };
  const info = db.prepare('INSERT INTO fantasy_teams(season,manager_name,team_name,user_id,picks,captain,created_by) VALUES (?,?,?,?,?,?,?)')
    .run(season, values.manager_name, values.team_name, uid, JSON.stringify(picks), cap.name, by);
  return { ok: true, row: { id: info.lastInsertRowid, ...values, captain: cap.name, picks, cost } };
}

function removeTeam(db, season, id) {
  const t = db.prepare('SELECT * FROM fantasy_teams WHERE id=? AND season=?').get(id, season);
  if (!t) return { ok: false, error: 'No such team.' };
  db.prepare('DELETE FROM fantasy_teams WHERE id=?').run(id);
  return { ok: true, row: t };
}

module.exports = { pool, teams, addPlayer, removePlayer, addTeam, removeTeam };
