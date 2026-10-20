'use strict';
// Member birthdays. users.date_of_birth is 'MM-DD' (year unknown) or 'YYYY-MM-DD'.
// Publicly only ever shown as day + month; the year stays admin-only.
const Soc = require('./society');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DIM = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Today's date in Europe/London as YYYY-MM-DD. */
function londonToday(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

/** Admin input -> stored value. Accepts "17 Oct", "17 October", "17/10", "17-10", "17/10/1976", "1976-10-17", "--10-17". '' -> null. Throws on junk. */
function parse(input) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return null;
  let y = null, m, d, r;
  if ((r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = s.match(/^-{0,2}(\d{1,2})-(\d{1,2})$/)) && s.startsWith('--')) { m = +r[1]; d = +r[2]; }
  else if ((r = s.match(/^(\d{1,2})[/.\- ](\d{1,2})(?:[/.\- ](\d{4}))?$/))) { d = +r[1]; m = +r[2]; y = r[3] ? +r[3] : null; }
  else if ((r = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,})\.?,?(?:\s+(\d{4}))?$/))) {
    d = +r[1]; m = MONTHS.findIndex((n) => n.toLowerCase().startsWith(r[2].toLowerCase().slice(0, 3))) + 1; y = r[3] ? +r[3] : null;
  } else throw new Error('Use a date like 17 Oct, 17/10 or 17/10/1976');
  if (!(m >= 1 && m <= 12) || !(d >= 1 && d <= DIM[m - 1])) throw new Error('That isn’t a real day and month');
  if (y != null && (y < 1900 || y > new Date().getFullYear())) throw new Error('That year doesn’t look right');
  if (y != null && m === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) throw new Error('That year has no 29 February');
  const p = (n) => String(n).padStart(2, '0');
  return (y ? `${y}-` : '') + `${p(m)}-${p(d)}`;
}
const md = (dob) => { const r = String(dob || '').match(/(\d{2})-(\d{2})$/); return r ? { m: +r[1], d: +r[2] } : null; };
/** Public label: "17 October" (never the year). */
function dayMonth(dob) { const x = md(dob); return x ? `${x.d} ${MONTHS[x.m - 1]}` : ''; }
/** Admin form value: "17 Oct" or "17 Oct 1976". */
function adminLabel(dob) { const x = md(dob); if (!x) return ''; const y = String(dob).match(/^(\d{4})-/); return `${x.d} ${MONTHS[x.m - 1].slice(0, 3)}${y ? ' ' + y[1] : ''}`; }

const isLeap = (y) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
/** Days from today (YYYY-MM-DD) to the next birthday; 29 Feb falls on 28 Feb in other years. */
function daysUntil(dob, today) {
  const x = md(dob); if (!x) return null;
  const [ty, tm, td] = today.split('-').map(Number);
  const t0 = Date.UTC(ty, tm - 1, td);
  for (const y of [ty, ty + 1]) {
    const d = x.m === 2 && x.d === 29 && !isLeap(y) ? 28 : x.d;
    const t = Date.UTC(y, x.m - 1, d);
    if (t >= t0) return Math.round((t - t0) / 864e5);
  }
  return null;
}

function list(db, today = londonToday(), { upcoming = 5 } = {}) {
  const rows = db.prepare("SELECT id, name, nickname, date_of_birth FROM users WHERE status='active' AND date_of_birth IS NOT NULL AND date_of_birth<>''").all()
    .map((u) => ({ id: u.id, name: u.name, nickname: u.nickname, dayMonth: dayMonth(u.date_of_birth), days: daysUntil(u.date_of_birth, today) }))
    .filter((u) => u.days != null).sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
  return { today: rows.filter((u) => u.days === 0), upcoming: rows.filter((u) => u.days > 0).slice(0, upcoming) };
}

const fmtDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return `${d} ${MONTHS[m - 1]} ${y}`; };
const pl = (n, w, p = w + 's') => `${n} ${n === 1 ? w : p}`;

/** Career highlights from the results database: [{icon, label, text}]. Only lines with real data are returned. */
function highlights(db, uid) {
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  if (!u) return [];
  const out = []; const add = (icon, label, text) => out.push({ icon, label, text });
  const rows = db.prepare(`SELECT r.stableford, r.position, e.event_date, e.title, s.year, c.name AS course FROM results r JOIN events e ON e.id=r.event_id
    LEFT JOIN seasons s ON s.id=e.season_id LEFT JOIN courses c ON c.id=e.course_id WHERE r.user_id=? AND e.status='completed' ORDER BY e.event_date`).all(uid);
  const years = new Set(rows.map((r) => r.year).filter(Boolean));
  for (const r of db.prepare('SELECT s.year FROM season_handicaps h JOIN seasons s ON s.id=h.season_id WHERE h.user_id=?').all(uid)) years.add(r.year);
  const ys = [...years].sort((a, b) => a - b);
  if (ys.length) add('📅', 'Seasons', `${pl(ys.length, 'season')} with the society, ${ys[0] === ys.at(-1) ? `in ${ys[0]}` : `from ${ys[0]} to ${ys.at(-1)}`}`);
  if (rows.length) {
    const wins = rows.filter((r) => r.position === 1).length, pods = rows.filter((r) => r.position && r.position <= 3).length;
    add('⛳', 'Rounds', `${pl(rows.length, 'round')} on record`);
    if (wins || pods) add('🥇', 'Wins', `${pl(wins, 'win')} and ${pl(pods, 'podium finish', 'podium finishes')}`);
    const stb = rows.filter((r) => r.stableford != null);
    if (stb.length) {
      const best = stb.reduce((a, b) => (b.stableford > a.stableford ? b : a));
      add('🔥', 'Best score', `${best.stableford} points${best.course ? ' at ' + best.course : ''}, ${fmtDate(best.event_date)}${best.position === 1 ? ' (won it)' : ''}`);
      const avg = stb.reduce((s, r) => s + r.stableford, 0) / stb.length;
      add('📊', 'Average', `${(Math.round(avg * 10) / 10).toFixed(1)} Stableford points a round`);
      const forty = stb.filter((r) => r.stableford >= 40).length;
      if (forty) add('🚀', '40-pointers', `${pl(forty, 'round')} of 40 points or more`);
    }
    const byCourse = {}; for (const r of rows) if (r.course) byCourse[r.course] = (byCourse[r.course] || 0) + 1;
    const fav = Object.entries(byCourse).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (fav && fav[1] > 1) add('🗺️', 'Most played', `${fav[0]}, ${pl(fav[1], 'round')}`);
  }
  const bird = db.prepare("SELECT COALESCE(SUM(value),0) v FROM comp_scores WHERE comp='birdie' AND user_id=?").get(uid).v;
  if (bird) add('🐦', 'Birdie League', `${bird} Birdie League ${bird === 1 ? 'point' : 'points'} (birdies, with eagles counting double)`);
  const badges = Soc.badges(Soc.parseAchievements(u.achievements));
  const hon = db.prepare(`SELECT h.year, c.name FROM honours h JOIN honour_categories c ON c.id=h.category_id WHERE h.user_id=? OR h.partner_id=? ORDER BY h.year`).all(uid, uid);
  const titles = [...badges.filter((b) => b.key !== 'hioc').map((b) => `${b.icon} ${b.label}`), ...hon.map((h) => `${h.name} ${h.year}`)];
  if (titles.length) add('🏆', 'Honours', titles.join(' · '));
  const hioc = badges.find((b) => b.key === 'hioc'); if (hioc) add('🎯', 'Hole in one', hioc.label);
  const aw = db.prepare(`SELECT t.name, t.icon, s.year FROM award_grants g JOIN award_types t ON t.id=g.award_type_id JOIN seasons s ON s.id=g.season_id WHERE g.user_id=? ORDER BY s.year`).all(uid);
  if (aw.length) add('🎖️', 'Awards', aw.map((a) => `${a.name} ${a.year}`).join(' · '));
  const ry = db.prepare('SELECT c.year FROM ryder_players p JOIN ryder_cups c ON c.id=p.cup_id WHERE p.user_id=? ORDER BY c.year').all(uid);
  if (ry.length) add('🇪🇺', 'Ryder Cup', `Played in ${pl(ry.length, 'Ryder Cup')} (${ry.map((r) => r.year).join(', ')})`);
  const lows = [u.lowest_index, u.handicap_index,
    ...db.prepare('SELECT lowest_index v FROM season_handicaps WHERE user_id=? UNION ALL SELECT end_index FROM season_handicaps WHERE user_id=? UNION ALL SELECT index_after FROM handicap_history WHERE user_id=?').all(uid, uid, uid).map((r) => r.v)]
    .filter((v) => v != null);
  if (lows.length) add('📉', 'Lowest handicap', `${Math.min(...lows).toFixed(1)}${u.handicap_index != null ? ` (plays off ${u.handicap_index.toFixed(1)} now)` : ''}`);
  const cut = db.prepare(`SELECT s.year, h.start_index - h.end_index AS c FROM season_handicaps h JOIN seasons s ON s.id=h.season_id
    WHERE h.user_id=? AND h.start_index IS NOT NULL AND h.end_index IS NOT NULL ORDER BY c DESC, s.year LIMIT 1`).get(uid);
  if (cut && cut.c >= 1) add('✂️', 'Biggest cut', `${(Math.round(cut.c * 10) / 10).toFixed(1)} shots off in ${cut.year}`);
  return out;
}

module.exports = { londonToday, parse, dayMonth, adminLabel, daysUntil, list, highlights, MONTHS };
