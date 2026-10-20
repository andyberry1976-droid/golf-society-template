'use strict';
// Switchable site modules. Each is stored as settings key `feature_<key>` = '1' | '0'.
// When off: its public paths 404, its admin pages 404 and links to them are hidden.
// Data is never touched, so switching back on restores everything.
const FEATURES = [
  { key: 'rsvp', label: 'RSVPs & waitlist', hint: 'RSVP buttons, places left, who’s in and the waitlist on events.', paths: [/^\/events\/\d+\/rsvp(-admin)?$/] },
  { key: 'events', label: 'Events list', hint: 'The Events pages and the upcoming events on the home page.', paths: [/^\/events(\/|$)/, /^\/admin\/events(\/|$)/] },
  { key: 'oom', label: 'Order of Merit', paths: [/^\/standings$/, /^\/admin\/seasons(\/|$)/] },
  { key: 'birdie', label: 'Birdie League', paths: [/^\/birdie-league$/] },
  { key: 'fedex', label: 'FedEx Cup', paths: [/^\/fedex$/] },
  { key: 'matchplay', label: 'Matchplay', paths: [/^\/matchplay$/, /^\/admin\/matchplay(\/|$)/] },
  { key: 'majors', label: 'Majors & Euro', paths: [/^\/majors$/, /^\/admin\/tournaments(\/|$)/] },
  { key: 'fame', label: 'Hall of Fame', paths: [/^\/hall-of-fame$/] },
  { key: 'handicaps', label: 'Handicap Records', paths: [/^\/handicaps$/] },
  { key: 'records', label: 'Records', paths: [/^\/records$/, /^\/admin\/records(\/|$)/] },
  { key: 'honours', label: 'Roll of Honour', paths: [/^\/honours$/, /^\/admin\/honours(\/|$)/] },
  { key: 'awards', label: 'Awards', paths: [/^\/awards$/, /^\/admin\/awards(\/|$)/] },
  { key: 'rules', label: 'Rules page', paths: [/^\/rules$/] },
  { key: 'join', label: 'Join requests', hint: 'The Join us page and the admin join-request queue.', paths: [/^\/join(\/|$)/, /^\/admin\/requests(\/|$)/] },
  { key: 'subs', label: 'Membership subs', hint: 'Admin → Subs: who has paid this season. Members see only their own status.', paths: [/^\/admin\/subs(\/|\.xlsx|$)/] },
  { key: 'ryder', label: 'Ryder Cup', hint: 'The Ryder Cup history page: teams, captains, sessions and player points.', paths: [/^\/ryder-cup$/] },
  { key: 'birthdays', label: 'Birthdays', hint: 'The Birthdays page (day and month only, never the year) and a home-page banner on birthday days.', paths: [/^\/birthdays$/] },
  { key: 'fantasy', label: 'Fantasy League (teaser)', hint: 'A “Coming in 2027” teaser page for the Fantasy League. No functionality yet.', paths: [/^\/fantasy-league$/] },
  { key: 'scramble', label: 'Texas Scramble', hint: 'Team scramble results (not part of the Order of Merit or any stats).', paths: [/^\/texas-scramble$/] },
  { key: 'odds', label: 'Odds (for fun)', hint: 'Fun odds for each player on the next upcoming event page, worked out from this season’s scores.', paths: [] },
  { key: 'engine', label: 'Custom competitions & leagues', hint: 'Any format and scoring (presets: Stableford, medal, par/bogey, scramble, better-ball, matchplay), hole-by-hole or totals, plus custom league tables.', paths: [/^\/leagues(\/|$)/, /^\/comp-results(\/|$)/, /^\/admin\/competition-types(\/|$)/, /^\/admin\/engine(\/|$)/, /^\/admin\/leagues(\/|$)/] },
  { key: 'profile_stats', label: 'Player profile stats', hint: 'The numbers panel and recent results on player profiles.', paths: [] },
];
const KEYS = FEATURES.map((f) => f.key);

// SOCIETY_FEATURES: comma list, e.g. "-rsvp,-awards" or "rsvp=off,awards=0" or "all". Unlisted = on.
function parseEnv(str) {
  const out = {};
  for (const k of KEYS) out[k] = '1';
  for (let t of String(str || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    let v = '1';
    if (t.startsWith('-') || t.startsWith('!')) { v = '0'; t = t.slice(1); }
    const m = t.match(/^([a-z_]+)\s*[=:]\s*(\w+)$/);
    if (m) { t = m[1]; v = /^(0|off|false|no)$/.test(m[2]) ? '0' : '1'; }
    if (t === 'none') { for (const k of KEYS) out[k] = '0'; continue; }
    if (out[t] !== undefined) out[t] = v;
  }
  return out;
}
// Config flag names (site.config.json "features") -> internal module keys.
const ALIASES = { rsvp: 'rsvp', birdie_league: 'birdie', fedex_cup: 'fedex', matchplay: 'matchplay', majors: 'majors', hall_of_fame: 'fame', awards: 'awards' };
const toKey = (name) => (KEYS.includes(name) ? name : ALIASES[name] || null);

/** Settings rows for the feature switches: site config defaults, then SOCIETY_FEATURES env tokens on top. */
function defaults(site = null, env = process.env.SOCIETY_FEATURES) {
  const out = {};
  for (const k of KEYS) out[k] = '1';
  if (site && site.features) for (const [n, v] of Object.entries(site.features)) { const k = toKey(n); if (k) out[k] = v ? '1' : '0'; }
  if (env) {
    const fromEnv = parseEnv(env); const listed = parseEnv(''); // tokens actually present in env differ from all-on, or are named explicitly
    for (const k of KEYS) if (fromEnv[k] !== listed[k] || new RegExp(`(^|,)\\s*[-!]?${k}\\b`, 'i').test(env) || /\bnone\b|\ball\b/i.test(env)) out[k] = fromEnv[k];
  }
  const o = {};
  for (const [k, v] of Object.entries(out)) o[`feature_${k}`] = v;
  return o;
}
function fromSettings(S) {
  const on = {};
  for (const k of KEYS) on[k] = S[`feature_${k}`] !== '0';
  const offPaths = FEATURES.filter((f) => !on[f.key]).flatMap((f) => f.paths);
  const blocked = (p) => offPaths.some((re) => re.test(String(p).split(/[?#]/)[0]));
  // admin Birdies & FedEx page only goes when both are off
  const blockedAll = (p) => blocked(p) || (/^\/admin\/comps(\/|$)/.test(p) && !on.birdie && !on.fedex);
  return { on, blocked: blockedAll, link: (href) => !blockedAll(href) };
}
module.exports = { FEATURES, KEYS, ALIASES, toKey, parseEnv, defaults, fromSettings };
