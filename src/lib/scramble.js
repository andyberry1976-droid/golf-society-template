'use strict';
// Team events (Texas scrambles). Kept apart from events/results so they never touch the OoM, stats awards, odds or fantasy.
const fs = require('fs');
const path = require('path');

/** Insert any team events from sites/<slug>/team-events.json that aren't in the database yet (by slug). */
function ensureFromSite(db, site) {
  const file = site && site.dir && path.join(site.dir, 'team-events.json');
  if (!file || !fs.existsSync(file)) return 0;
  let n = 0;
  for (const ev of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const hash = require('crypto').createHash('sha1').update(JSON.stringify(ev)).digest('hex');
    const cur = db.prepare('SELECT id, src_hash FROM team_events WHERE slug=?').get(ev.slug);
    if (cur && cur.src_hash === hash) continue;
    if (cur) db.prepare('DELETE FROM team_events WHERE id=?').run(cur.id); // source changed: replace this event only
    const id = db.prepare('INSERT INTO team_events(slug,year,title,course,event_date,format,src_hash) VALUES (?,?,?,?,?,?,?)')
      .run(ev.slug, ev.year, ev.title, ev.course || null, ev.event_date || null, ev.format || null, hash).lastInsertRowid;
    // link a player to a member only on an exact full-name match with exactly one active member,
    // and only if that name appears once in the event (two "Player 8"s can't both be the same member)
    const seen = {}; for (const r of ev.results) for (const p of r.players) seen[p.name] = (seen[p.name] || 0) + 1;
    const byName = db.prepare("SELECT id FROM users WHERE name=? AND status='active'");
    for (const r of ev.results) {
      const players = r.players.map((p) => { const us = seen[p.name] === 1 ? byName.all(p.name) : []; return { name: p.name, hcp: p.hcp ?? null, user_id: us.length === 1 ? us[0].id : null }; });
      db.prepare('INSERT INTO team_results(team_event_id,position,team,players,hcp,score,to_par) VALUES (?,?,?,?,?,?,?)')
        .run(id, r.position, r.team, JSON.stringify(players), r.hcp ?? null, r.score ?? null, r.to_par ?? null);
    }
    n++;
  }
  return n;
}

/** All team events, newest first, each with results ordered as listed; joint positions flagged. */
function list(db) {
  return db.prepare("SELECT * FROM team_events ORDER BY year DESC, COALESCE(event_date, year || '-12-31') DESC, id DESC").all().map((e) => {
    const rows = db.prepare('SELECT * FROM team_results WHERE team_event_id=? ORDER BY position, id').all(e.id).map((r) => ({ ...r, players: JSON.parse(r.players) }));
    const cnt = {}; for (const r of rows) cnt[r.position] = (cnt[r.position] || 0) + 1;
    for (const r of rows) r.joint = cnt[r.position] > 1;
    return { ...e, results: rows };
  });
}
module.exports = { ensureFromSite, list };
