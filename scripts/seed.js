'use strict';
/**
 * Seed script.
 *   npm run seed                 the Demo 2026 season imported from the society spreadsheet (+3 demo logins)
 *   node scripts/seed.js --demo  the old fictional Fairway Flamingos demo (18 members, 3 seasons…)
 *   node scripts/seed.js --reset delete the database file first
 *   node scripts/seed.js --blank only the starter data + first admin from ADMIN_EMAIL / ADMIN_PASSWORD
 * In NODE_ENV=production the demo data is refused unless SEED_DEMO=true.
 */
const fs = require('fs');
const path = require('path');
const { load, DEMO_PASSWORD } = require('../src/config');
const { open, setSetting } = require('../src/db');
const users = require('../src/lib/users');
const { recomputeAll } = require('../src/lib/engine');
const { saveResults } = require('../src/lib/results');
const rsvpLib = require('../src/lib/rsvp');
const H = require('../src/lib/handicap');
const { seedBase, AWARD_TYPES } = require('../src/lib/baseline');
const sample = require('./sample-data.json');

// deterministic RNG so every fresh demo looks the same
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const R = rng(20261010);
const randn = () => { let u = 0; let v = 0; while (!u) u = R(); while (!v) v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const pick = (a) => a[Math.floor(R() * a.length)];
const shuffle = (a) => { const b = a.slice(); for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
function nthSat(year, month, n) { const d = new Date(year, month - 1, 1); while (d.getDay() !== 6) d.setDate(d.getDate() + 1); d.setDate(d.getDate() + (n - 1) * 7); return d; }

const COURSES = [
  ['Wobbly Pines Golf Club', 'Yellow', 71, 70.4, 128, 'Little Wobbling'],
  ['Little Mudwick Links', 'Yellow', 72, 71.8, 131, 'Mudwick-on-Sea'],
  ["St Fumble's Park", 'Yellow', 70, 69.2, 124, 'Fumbleton'],
  ['Bunkerton Hall', 'Yellow', 73, 72.5, 133, 'Bunkerton'],
];
const CITATIONS = {
  'Wooden Spoon': 'Finished last so consistently that we named the trophy after the spoon.',
  'Sandbagger of the Year': 'Handicap 21. Plays like an 11. Pure coincidence, apparently.',
  'Mr Consistency': 'Shot 84, 84, 84 and 85. Even his tea order is identical every time.',
  'Best Dressed': 'Pink plus-fours, matching socks, zero apologies.',
  'Longest Drive': 'Found the ball in the next postcode. Declined to look for the divot.',
  'Nearest the Pin': 'Nine inches. She asked for a tape measure. Twice.',
  'Comeback Kid': 'Down 6.1 shots after a winter of lessons and sheer spite.',
  'Biggest Moaner': 'Blamed the wind, the greens, the grass, the moon and a passing pigeon.',
  'Lost Ball King': 'Fourteen balls in one round. The pond made him an honorary member.',
  'Sand Castle Award': 'Spent more time in bunkers than a beach donkey. Built a lovely turret.',
  'Most Mulligans': 'It was only a practice swing, he says. Every. Single. Tee shot.',
  'Spirit of the Society': 'Always has a spare ball, a plaster and a kind word. Usually in that order.',
};
const AWARD_WINNERS = { 'Wooden Spoon': 'Player 54', 'Sandbagger of the Year': 'Player 52', 'Mr Consistency': 'Player 43', 'Best Dressed': 'Player 45', 'Longest Drive': 'Player 48', 'Nearest the Pin': 'Player 42', 'Comeback Kid': 'Player 50', 'Biggest Moaner': 'Player 46', 'Lost Ball King': 'Player 53', 'Sand Castle Award': 'Player 51', 'Most Mulligans': 'Player 55', 'Spirit of the Society': 'Player 47' };

// template for a full season: [title, format, month, nth Saturday, honour, multiplier, courseIdx, cost]
const SEASON_TEMPLATE = [
  ['Spring Opener', 'stableford', 4, 2, 'Spring Opener', 1, 0, 3800],
  ['Mudwick Medal', 'medal', 5, 3, null, 1, 1, 3500],
  ['Midsummer Texas Scramble', 'scramble', 6, 2, null, 1, 1, 3200],
  ['Matchplay Cup', 'matchplay', 7, 1, 'Matchplay Cup', 1, 2, 3500],
  ["Captain's Day", 'stableford', 8, 3, "Captain's Day", 1.5, 3, 4500],
  ['Bunkerton Bash', 'stableford', 9, 1, null, 1, 3, 3800],
  ['Harvest Medal Stableford', 'stableford', 9, 4, null, 1, 0, 3800],
  ['Autumn Classic', 'medal', 10, 3, null, 1, 2, 3500],
  ['Winter Foursomes Trophy', 'foursomes', 12, 2, 'Winter Foursomes', 1, 3, 3000],
];
const FORMAT_BASIS = { stableford: ['stableford', 1], medal: ['stroke_net', 1], scramble: ['manual', 0], matchplay: ['manual', 0], foursomes: ['manual', 0] };

function seedDemo(db, { now = new Date(), log = () => {} } = {}) {
  seedBase(db);
  // the fictional demo uses the WHS-style engine, position points and the Flamingos branding
  setSetting(db, 'handicap_mode', 'whs');
  setSetting(db, 'oom_default_scheme', JSON.stringify({ positions: [30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1], participation: 5, bestN: null }));
  for (const [k, v] of Object.entries({ society_name: 'The Fairway Flamingos Golf Society', short_name: 'Fairway Flamingos', hero_title: 'The Fairway Flamingos', tagline: 'Pink socks. Wonky swings. Serious banter. A friendly society for golfers who take the game lightly and the sausage rolls very seriously.', footer_blurb: 'A fictional society for fun, friendship and fairly flexible rules. Rebrand me in Admin → Settings.' })) setSetting(db, k, v);
  const Y = now.getFullYear();
  const hash = users.hashPassword(DEMO_PASSWORD);
  // wipe baseline's empty season so ours are canonical
  db.prepare('DELETE FROM seasons').run();

  // ---- courses
  const courseIds = COURSES.map((c) => db.prepare('INSERT INTO courses(name,tee,par,rating,slope,location) VALUES (?,?,?,?,?,?)').run(...c).lastInsertRowid);
  const courseRow = (i) => ({ id: courseIds[i], par: COURSES[i][2], rating: COURSES[i][3], slope: COURSES[i][4] });

  // ---- members
  const role = { 'Player 47': 'admin', 'Player 41': 'captain' };
  const emailFor = (n) => (n === 'Player 47' ? 'admin@example.test' : n === 'Player 41' ? 'captain@example.test' : n === 'Player 43' ? 'member@example.test' : 'player' + String(n).replace(/^Player /,'') + '@example.test');
  const people = sample.players.map((p) => {
    const joined = Math.max(2019, p.joined > Y - 3 ? Y - 4 : p.joined);
    const id = users.createUser(db, { name: p.name, email: emailFor(p.name), passwordHash: hash, role: role[p.name] || 'member', index: p.hcp, nickname: p.nick, homeCourse: p.home, joinedOn: `${joined}-03-01`,
      bio: null });
    return { id, name: p.name, skill: p.hcp, keen: 0.55 + R() * 0.35 };
  });
  db.prepare("UPDATE users SET bio=? WHERE name='Player 47'").run('Society secretary, ball-spotter and keeper of the spare plasters.');
  db.prepare("UPDATE users SET bio=? WHERE name='Player 41'").run('Current captain. Will accept bribes in the form of bacon rolls.');
  log(`members: ${people.length}`);

  // ---- warm-up: 20 pre-app general-play rounds each so indexes are properly established
  const insX = db.prepare('INSERT INTO extra_rounds(user_id,played_on,course_name,ags,rating,slope,par,note) VALUES (?,?,?,?,?,?,?,?)');
  for (const p of people) {
    for (let k = 0; k < 20; k++) {
      const c = COURSES[k % 4];
      const diff = p.skill + randn() * (2 + p.skill * 0.1) + 0.6;
      const ags = Math.round(diff * c[4] / 113 + c[3]);
      insX.run(p.id, iso(addDays(new Date(Y - 3, 5, 1), k * 10)), c[0], ags, c[3], c[4], c[2], 'Pre-app card');
    }
  }
  recomputeAll(db);

  // ---- seasons
  const lastSat = (() => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); const back = ((d.getDay() + 1) % 7) || 7; return addDays(d, -back); })();
  const nextSat = (() => { const d = new Date(now.getFullYear(), now.getMonth(), now.getDate()); const fwd = ((6 - d.getDay() + 7) % 7) || 7; return addDays(d, fwd); })();
  const sIns = db.prepare('INSERT INTO seasons(name,year,start_date,end_date,status,scheme) VALUES (?,?,?,?,?,?)');
  const season = {};
  season[Y - 2] = sIns.run(String(Y - 2), Y - 2, `${Y - 2}-01-01`, `${Y - 2}-12-31`, 'closed', null).lastInsertRowid;
  // 2nd-year scheme tweak so the "custom scheme / best-N" feature is demonstrable
  season[Y - 1] = sIns.run(String(Y - 1), Y - 1, `${Y - 1}-01-01`, `${Y - 1}-12-31`, 'closed', JSON.stringify({ positions: [30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1], participation: 5, bestN: 7 })).lastInsertRowid;
  const curStart = [`${Y}-01-01`, iso(addDays(lastSat, -7 * 3 * 7 - 7))].sort()[0];
  season[Y] = sIns.run(String(Y), Y, curStart, `${Y}-12-31`, 'open', null).lastInsertRowid;
  const cat = Object.fromEntries(db.prepare('SELECT id,name FROM honour_categories').all().map((c) => [c.name, c.id]));

  const eIns = db.prepare(`INSERT INTO events(season_id,title,course_id,event_date,tee_time,format,scoring_basis,cost_pence,capacity,notes,status,counts_handicap,counts_oom,points_multiplier,allowance_pct,honour_category_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const NOTES = { stableford: 'Full handicap allowance. Bacon rolls at the turn.', medal: 'Net medal. Bring a pencil and a good excuse.', scramble: 'Teams of four drawn on the day. Pink socks = bonus shot (we wish).', matchplay: 'Draw announced the week before. Bring your trash talk.', foursomes: 'Greensomes. Mince pies and mulled apple juice after play.' };
  const plan = [];
  for (const yr of [Y - 2, Y - 1]) {
    for (const t of SEASON_TEMPLATE) plan.push({ season: season[yr], date: nthSat(yr, t[2], t[3]), t });
  }
  // current season: 8 played events, 3-weekly, ending on last Saturday
  const curPast = [SEASON_TEMPLATE[0], SEASON_TEMPLATE[1], SEASON_TEMPLATE[2], SEASON_TEMPLATE[3], SEASON_TEMPLATE[4], SEASON_TEMPLATE[5], SEASON_TEMPLATE[7], SEASON_TEMPLATE[6]];
  curPast.forEach((t, i) => plan.push({ season: season[Y], date: addDays(lastSat, -(7 - i) * 21), t }));
  plan.sort((a, b) => a.date - b.date);

  const playedEvents = [];
  for (const pe of plan) {
    const t = pe.t; const [basis, hcp] = FORMAT_BASIS[t[1]];
    const id = eIns.run(pe.season, t[0], courseIds[t[6]], iso(pe.date), t[1] === 'foursomes' ? '10:30' : '09:' + pick(['00', '12', '24', '36']), t[1], basis, t[7], null, NOTES[t[1]], 'scheduled', hcp, 1, t[5], 95, t[4] ? cat[t[4]] : null).lastInsertRowid;
    playedEvents.push({ id, t, course: courseRow(t[6]), date: pe.date, season: pe.season });
  }

  // ---- simulate results chronologically so handicaps evolve realistically
  const stableIdx = (p) => db.prepare('SELECT handicap_index FROM users WHERE id=?').get(p.id).handicap_index;
  for (const ev of playedEvents) {
    const t = ev.t;
    let att = people.filter((p) => R() < p.keen);
    if (att.length < 12) att = shuffle(people).slice(0, 12 + Math.floor(R() * 3));
    if (t[1] === 'foursomes' && att.length % 2) att.pop();
    if (t[1] === 'scramble') att = att.slice(0, att.length - (att.length % 4));
    if (t[1] === 'matchplay') att = shuffle(att).slice(0, 16 >= att.length ? att.length - (att.length % 2) : 16);
    const rows = [];
    const perf = att.map((p) => {
      const idx = stableIdx(p) ?? p.skill;
      const diff = p.skill + randn() * (2 + p.skill * 0.1) + 0.5 + (p.name === 'Player 52' ? -4.5 : 0) + (p.name === 'Player 50' ? -0.8 : 0);
      const gross = Math.round(diff * ev.course.slope / 113 + ev.course.rating);
      const ch = H.courseHandicap(idx, ev.course); const ph = H.playingHandicap(ch, 95);
      return { p, gross, stb: Math.max(0, 36 + ev.course.par + ph - gross), diff };
    });
    if (['stableford', 'medal'].includes(t[1])) {
      perf.forEach((x, i) => rows.push(t[1] === 'stableford' && i % 2 ? { user_id: x.p.id, stableford: x.stb } : { user_id: x.p.id, gross: x.gross }));
    } else if (t[1] === 'matchplay') {
      const order = perf.slice().sort((a, b) => (a.diff + randn() * 3) - (b.diff + randn() * 3));
      order.forEach((x, i) => { const pos = i === 0 ? 1 : i === 1 ? 2 : i < 4 ? 3 : i < 8 ? 5 : 9; rows.push({ user_id: x.p.id, position: pos, note: i === 0 ? pick(['2 & 1', '3 & 2', '19th hole', '1 up', '4 & 3']) : '' }); });
    } else if (t[1] === 'scramble') {
      const teams = []; const sh = shuffle(perf);
      for (let i = 0; i < sh.length; i += 4) teams.push(sh.slice(i, i + 4));
      const scored = teams.map((tm, i) => ({ tm, name: pick(['Pink Panthers', 'Sand Wedges', 'Birdie Brigade', 'Divot Dodgers', 'Slice Girls', 'Mulligan Mob']) + (i ? '' : ''), s: 62 + Math.round(randn() * 3) })).sort((a, b) => a.s - b.s);
      scored.forEach((g, i) => g.tm.forEach((x) => rows.push({ user_id: x.p.id, position: i + 1, note: `${g.name} (${g.s})` })));
    } else { // foursomes: pairs
      const sh = shuffle(perf); const pairs = [];
      for (let i = 0; i < sh.length; i += 2) pairs.push([sh[i], sh[i + 1]]);
      const scored = pairs.map((pr) => ({ pr, pts: 30 + Math.round(randn() * 3) + Math.round((18 - (pr[0].p.skill + pr[1].p.skill) / 2) / 8) })).sort((a, b) => b.pts - a.pts);
      let rank = 0; let prev;
      scored.forEach((g, i) => { if (g.pts !== prev) rank = i + 1; prev = g.pts; g.pr.forEach((x) => rows.push({ user_id: x.p.id, position: rank, note: `${g.pts} pts (pairs)` })); });
    }
    saveResults(db, ev.id, rows);
  }
  // highlights on the most recent event
  const lastEv = playedEvents[playedEvents.length - 1];
  const lastRes = db.prepare('SELECT u.name FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY r.position DESC, r.points LIMIT 1').get(lastEv.id);
  db.prepare('UPDATE events SET highlights=? WHERE id=?').run(['Nearest the pin: Player 50 (6 ft 2 in)', 'Longest drive: Player 48', 'Birdies on the day: 11', `Wooden spoon of the day: ${lastRes.name}`].join('\n'), lastEv.id);
  log(`played events: ${playedEvents.length}`);

  // ---- close the two historic seasons (adds Order of Merit champions to the roll of honour)
  db.prepare("UPDATE seasons SET status='closed' WHERE id IN (?,?)").run(season[Y - 2], season[Y - 1]);
  recomputeAll(db);

  // ---- historic roll of honour (pre-app years)
  const nameOf = (id) => sample.players.find((p) => p.id === id).name;
  const uid = Object.fromEntries(db.prepare('SELECT id,name FROM users').all().map((u) => [u.name, u.id]));
  const hIns = db.prepare("INSERT INTO honours(category_id,year,user_id,detail,source) VALUES (?,?,?,?,'manual')");
  const shift = Y - 2026; // keep the story consistent if you seed in a later year
  for (const h of sample.honours) {
    if (h.year + shift > Y - 3) continue;
    hIns.run(cat[h.event], h.year + shift, h.winner === null ? null : uid[nameOf(h.winner)], h.detail);
  }

  // ---- awards
  const types = Object.fromEntries(db.prepare('SELECT id,name FROM award_types').all().map((t) => [t.name, t.id]));
  const gIns = db.prepare('INSERT OR IGNORE INTO award_grants(award_type_id,season_id,user_id,citation) VALUES (?,?,?,?)');
  AWARD_TYPES.forEach((a) => gIns.run(types[a[0]], season[Y - 1], uid[AWARD_WINNERS[a[0]]], CITATIONS[a[0]]));
  [['Wooden Spoon', 'Player 53', 'Never troubled the scorers. Never troubled the fairway either.'], ['Sandbagger of the Year', 'Player 46', 'Index 15. Somehow keeps shooting 40 points.'], ['Best Dressed', 'Player 45', 'The plus-fours had their own entourage.'], ['Longest Drive', 'Player 48', 'Measured by satellite.'], ['Spirit of the Society', 'Player 47', 'Runs the whole show and still brings the biscuits.'], ['Comeback Kid', 'Player 48', 'Shaved four shots off his handicap in a single summer.']]
    .forEach((g) => gIns.run(types[g[0]], season[Y - 2], uid[g[1]], g[2]));
  [['Best Dressed', 'Player 40', 'Pink blazer, pink socks, pink golf balls. We admire the commitment.'], ['Nearest the Pin', 'Player 42', 'Two feet on the 7th. Declined to celebrate; celebrated anyway.'], ['Longest Drive', 'Player 43', 'Player 43 does what it says on the tin.'], ['Spirit of the Society', 'Player 47', 'Still has the spare plasters.']]
    .forEach((g) => gIns.run(types[g[0]], season[Y], uid[g[1]], g[2]));

  // ---- fun (hand-measured) records
  const cr = db.prepare('INSERT INTO custom_records(title,value,holder_user_id,holder_text,detail,icon,tint,sort) VALUES (?,?,?,?,?,?,?,?)');
  cr.run('Longest drive', '312 yds', uid['Player 48'], null, '7th at Little Mudwick · downwind', 's-drive', '#fde1f2', 1);
  cr.run('Most birdies in a round', '6', uid['Player 40'], null, 'Wobbly Pines · a good day', 's-spark', '#e6defa', 2);
  cr.run('Longest putt holed', '62 ft', uid['Player 47'], null, '18th green · she meant to leave it short', 's-pin', '#d9fbe9', 3);
  cr.run('Most lost balls in a round', '14', uid['Player 53'], null, 'The pond now knows his name', 's-lost', '#fde1f2', 4);

  // ---- upcoming events with RSVPs (one full with a waitlist)
  const upcoming = [
    { title: 'Autumn Stableford Classic', weeks: 0, course: 0, fmt: 'stableford', cap: 16, going: 13, cost: 3800, time: '09:12', note: 'Full handicap allowance. Bacon rolls at the turn.' },
    { title: 'Flamingo Texas Scramble', weeks: 3, course: 1, fmt: 'scramble', cap: 12, going: 8, cost: 3200, time: '10:00', note: 'Shotgun start. Pink socks = bonus shot (we wish).' },
    { title: 'Winter Matchplay Knockout — Round 1', weeks: 6, course: 2, fmt: 'matchplay', cap: 16, going: 5, cost: 3500, time: '08:40', note: 'Draw announced the week before. Bring your trash talk.' },
    { title: 'Winter Foursomes Trophy', weeks: 9, course: 3, fmt: 'foursomes', cap: 12, going: 12, wait: 3, cost: 3000, time: '11:30', hon: 'Winter Foursomes', note: 'Mince pies and mulled apple juice after play.' },
  ];
  const memberIds = people.map((p) => p.id);
  for (const u of upcoming) {
    const [basis, hcp] = FORMAT_BASIS[u.fmt];
    const id = eIns.run(season[Y], u.title, courseIds[u.course], iso(addDays(nextSat, u.weeks * 7)), u.time, u.fmt, basis, u.cost, u.cap, u.note, 'scheduled', hcp, 1, 1, 95, u.hon ? cat[u.hon] : null).lastInsertRowid;
    const order = shuffle(memberIds);
    order.slice(0, u.going + (u.wait || 0)).forEach((uidv) => rsvpLib.setRsvp(db, id, uidv, 'going'));
    // a few "can't make it"
    order.slice(u.going + (u.wait || 0), u.going + (u.wait || 0) + 2).forEach((uidv) => rsvpLib.setRsvp(db, id, uidv, 'not_going'));
  }
  // make sure the three demo logins have a nice story on the first event
  const first = db.prepare("SELECT id FROM events WHERE status='scheduled' ORDER BY event_date LIMIT 1").get().id;
  rsvpLib.setRsvp(db, first, uid['Player 47'], 'going');

  // ---- pending join requests for the admin queue
  const jr = db.prepare('INSERT INTO join_requests(name,email,password_hash,declared_index,home_course,message,invite_ok) VALUES (?,?,?,?,?,?,?)');
  jr.run('Player 56', 'player56@example.test', hash, 17.2, 'Wobbly Pines', 'Player 47 said you were short of a fourth. I own pink socks.', 1);
  jr.run('Player 57', 'player57@example.test', hash, null, null, 'New to golf but keen! No handicap yet.', 0);
  jr.run('Player 58', 'player58@example.test', hash, 9.8, "St Fumble's Park", null, 0);

  setSetting(db, 'est_text', `Est. ${Y - 12} · 18 holes of questionable decisions`);
  recomputeAll(db);
  return { people: people.length, events: playedEvents.length + upcoming.length };
}

function main() {
  const args = process.argv.slice(2);
  const config = load({ ...process.env, SESSION_SECRET: process.env.SESSION_SECRET || 'seed' });
  if (args.includes('--reset')) for (const ext of ['', '-wal', '-shm']) fs.rmSync(config.dbPath + ext, { force: true });
  const db = open(config.dbPath);
  const have = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  const blank = args.includes('--blank') || (config.production && process.env.SEED_DEMO !== 'true');
  if (have) { console.log('Database already has members — nothing to do. Use `node scripts/seed.js --reset` to start over (this DELETES the data).'); return; }
  if (blank) {
    if (!config.adminEmail || config.adminPassword.length < 10 || config.adminPassword === DEMO_PASSWORD) {
      console.error('Blank/production seed needs ADMIN_EMAIL and ADMIN_PASSWORD (min 10 chars, not the demo password).');
      process.exit(1);
    }
    seedBase(db);
    users.createUser(db, { name: config.adminName, email: config.adminEmail, passwordHash: users.hashPassword(config.adminPassword), role: 'admin' });
    setSetting(db, 'society_name', config.societyName);
    recomputeAll(db);
    console.log(`Created starter data and admin ${config.adminEmail}. Start the app and rebrand it in Admin → Settings.`);
    return;
  }
  const out = args.includes('--demo') ? seedDemo(db, { log: console.log }) : require('./seed-demo-site').seedDemo(db, { log: console.log });
  console.log(`\n${args.includes('--demo') ? 'Fictional demo' : 'Demo 2026'} data created: ${out.people} members, ${out.events} events.\nDEMO LOGINS (password for all: ${DEMO_PASSWORD}) — demo only, never use in production:\n  admin    admin@example.test\n  captain  captain@example.test\n  member   member@example.test`);
}

if (require.main === module) main();
module.exports = { seedDemo };
