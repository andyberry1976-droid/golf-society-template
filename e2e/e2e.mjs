// End-to-end test of the main flows, driven through a real browser (Playwright + system Chrome).
//   join request -> admin approves -> login -> RSVP -> waitlist promotion -> results entry
//   -> handicap update -> Order of Merit -> awards -> season close/roll of honour
// Runs against a freshly seeded throwaway database on port 3199 (never touches data/society.db).
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { launch, startServer, ACCOUNTS, DEMO_PASSWORD } from './lib.mjs';

const srv = await startServer({ port: Number(process.env.E2E_PORT || 3199) });
const browser = await launch();
const problems = [];
let step = 0;
const ok = (msg) => console.log(`  ✓ ${String(++step).padStart(2, '0')} ${msg}`);
const ro = () => new Database(srv.dbPath, { readonly: true });

async function session() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of 40[13]/.test(m.text())) problems.push('console.error: ' + m.text()); });
  page.on('response', (r) => { if (r.status() >= 500) problems.push(`HTTP ${r.status()} ${r.url()}`); });
  return page;
}
const go = (page, path) => page.goto(srv.base + path, { waitUntil: 'domcontentloaded' });
async function login(page, email, password = DEMO_PASSWORD) {
  await go(page, '/login');
  await page.fill('[name=email]', email);
  await page.fill('[name=password]', password);
  await Promise.all([page.waitForNavigation(), page.click('button[type=submit]:has-text("Log in")')]);
}
// assert.match with a short, readable failure message
const match = (text, re, what = '') => { if (!re.test(text)) assert.fail(`expected ${what || re} — page text starts: ${text.replace(/\s+/g, ' ').slice(0, 300)}`); };
const click = (page, sel) => Promise.all([page.waitForNavigation({ waitUntil: 'domcontentloaded' }), page.click(sel)]);

try {
  console.log('E2E against', srv.base);
  const PAT = { name: 'Player 59', email: 'player59@example.test', password: 'player59-secret-pass-1' };

  // ---- 1. Join request (visitor) ------------------------------------------------------------
  const visitor = await session();
  await go(visitor, '/join');
  await visitor.fill('[name=name]', PAT.name);
  await visitor.fill('[name=email]', PAT.email);
  await visitor.fill('[name=password]', PAT.password);
  await visitor.fill('[name=password2]', PAT.password);
  await visitor.fill('[name=handicap]', '20.0');
  await visitor.fill('[name=home_course]', 'Pinecrest GC');
  await visitor.fill('[name=invite_code]', 'CHANGEME');
  await click(visitor, 'button:has-text("Send my application")');
  match(await visitor.innerText('body'), /application|request|thanks/i);
  ok('visitor submits a join request with invite code');

  await login(visitor, PAT.email, PAT.password);
  match(await visitor.innerText('body'), /waiting for approval/i);
  assert.ok(visitor.url().includes('/login'), 'pending applicant cannot log in');
  ok('pending applicant cannot log in yet');

  // ---- 2. Admin approves ----------------------------------------------------------------------
  const admin = await session();
  await login(admin, ACCOUNTS.admin);
  await go(admin, '/admin');
  match(await admin.innerText('body'), /Player 59/);
  ok('admin dashboard lists the pending request');
  await go(admin, '/admin/requests');
  const reqRow = ro(); const reqId = reqRow.prepare('SELECT id FROM join_requests WHERE email=?').get(PAT.email).id; reqRow.close();
  await click(admin, `form[action="/admin/requests/${reqId}/approve"] button:has-text("Approve")`);
  match(await admin.innerText('body'), /approved|welcome|added/i);
  ok('admin approves the request (starting index 20.0 from the application)');

  // ---- 3. New member logs in and RSVPs --------------------------------------------------------
  await login(visitor, PAT.email, PAT.password);
  assert.ok(!visitor.url().includes('/login'));
  match(await visitor.innerText('body'), /Player 59/);
  ok('approved member logs in');

  let db = ro();
  const sched = db.prepare("SELECT id,title FROM events WHERE status='scheduled' ORDER BY event_date").all();
  const full = db.prepare("SELECT e.id FROM events e WHERE e.status='scheduled' AND e.capacity IS NOT NULL AND (SELECT COUNT(*) FROM rsvps r WHERE r.event_id=e.id AND r.status='going')>=e.capacity AND EXISTS (SELECT 1 FROM rsvps r WHERE r.event_id=e.id AND r.status='waitlist')").get().id;
  const open = sched.find((e) => e.id !== full);
  const resultsEvent = db.prepare("SELECT id,title FROM events WHERE status='scheduled' AND title LIKE 'Autumn Stableford%'").get();
  db.close();

  await go(visitor, `/events/${open.id}`);
  await click(visitor, 'button:has-text("I’m in!")');
  match(await visitor.innerText('body'), /You’re in|you.re going|You.re IN/i);
  ok(`member RSVPs "going" to "${open.title}"`);
  await click(visitor, 'button:has-text("Can’t make it after all")');
  await click(visitor, 'button:has-text("I’m in!")');
  ok('member can cancel and re-RSVP');

  // ---- 4. Waitlist: join a full event, then be promoted when someone cancels ----------------
  await go(visitor, `/events/${full}`);
  await click(visitor, 'button:has-text("Join the waitlist")');
  const waitTxt = await visitor.innerText('body');
  match(waitTxt, /#4 on the waitlist/);
  ok('joining the full event puts Player 59 #4 on the waitlist');

  db = ro();
  const going = db.prepare("SELECT u.email,u.name FROM rsvps r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND r.status='going' AND u.role='member' ORDER BY r.rowid LIMIT 1").get(full);
  const first = db.prepare("SELECT u.email,u.name FROM rsvps r JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND r.status='waitlist' ORDER BY r.queue_seq, r.rowid LIMIT 1").get(full);
  db.close();
  const canceller = await session();
  await login(canceller, going.email);
  await go(canceller, `/events/${full}`);
  await click(canceller, 'button:has-text("Can’t make it after all")');
  ok(`${going.name} cancels from the full event`);

  const promoted = await session();
  await login(promoted, first.email);
  await go(promoted, '/account');
  match(await promoted.innerText('body'), /now IN for/);
  await go(promoted, `/events/${full}`);
  match(await promoted.innerText('body'), /You’re in|You.re IN|going/i);
  ok(`${first.name} (first on the waitlist) is auto-promoted and notified`);
  await go(visitor, `/events/${full}`);
  match(await visitor.innerText('body'), /#3 on the waitlist/);
  ok('Player 59 moves up the queue to #3');

  // ---- 5. Results entry (captain) -> handicap, OoM ---------------------------------------------
  db = ro();
  const patBefore = db.prepare('SELECT id,handicap_index FROM users WHERE email=?').get(PAT.email);
  const rivals = db.prepare("SELECT id,name,handicap_index FROM users WHERE email IN (?,?,?)").all('player38@example.test', 'player39@example.test', ACCOUNTS.member);
  const rivalBefore = Object.fromEntries(rivals.map((r) => [r.id, r.handicap_index]));
  const patRoundsBefore = db.prepare('SELECT COUNT(*) n FROM handicap_history WHERE user_id=?').get(patBefore.id).n;
  db.close();
  assert.equal(patBefore.handicap_index, 20);

  const captain = await session();
  await login(captain, ACCOUNTS.captain);
  await go(captain, `/admin/events/${resultsEvent.id}/results`);
  const stb = async (name, pts) => captain.fill(`[aria-label="Stableford points for ${name}"]`, String(pts));
  await stb(PAT.name, 44);
  await stb(rivals[0].name, 38);
  await stb(rivals[1].name, 35);
  await stb(rivals[2].name, 29);
  await click(captain, 'button:has-text("Save results")');
  const evBody = await captain.innerText('body');
  match(evBody, /Results saved/);
  match(evBody, /Player 59/);
  ok(`captain enters stableford results for "${resultsEvent.title}"`);

  db = ro();
  const res = db.prepare('SELECT u.name, r.position, r.points, r.stableford FROM results r JOIN users u ON u.id=r.user_id WHERE r.event_id=? ORDER BY r.position').all(resultsEvent.id);
  assert.equal(res[0].name, PAT.name);
  assert.equal(res[0].position, 1);
  assert.ok(res[0].points > res[1].points);
  const patAfter = db.prepare('SELECT handicap_index FROM users WHERE id=?').get(patBefore.id);
  const patRoundsAfter = db.prepare('SELECT COUNT(*) n FROM handicap_history WHERE user_id=?').get(patBefore.id).n;
  const rivalAfter = Object.fromEntries(db.prepare('SELECT id,handicap_index FROM users WHERE id IN (' + rivals.map(() => '?').join(',') + ')').all(...rivals.map((r) => r.id)).map((r) => [r.id, r.handicap_index]));
  db.close();
  assert.equal(patAfter.handicap_index, 20, 'with fewer than 3 scoring rounds the declared index is kept (WHS needs 3)');
  assert.ok(Object.keys(rivalAfter).some((id) => rivalAfter[id] !== rivalBefore[id]), 'at least one established member’s index changed');
  ok(`winner ranked #1 automatically; established members' indexes updated; Player 59 keeps 20.0 until 3 rounds exist`);

  // Admin adds two general-play rounds for Player 59 (feature for bringing in outside scorecards)
  for (const [d, ags] of [['2026-09-05', 84], ['2026-09-19', 82]]) {
    await go(admin, `/admin/members/${patBefore.id}`);
    await admin.fill('form[action$="/extra-round"] [name=played_on]', d);
    await admin.fill('form[action$="/extra-round"] [name=course_name]', 'Pinecrest GC');
    await admin.fill('form[action$="/extra-round"] [name=ags]', String(ags));
    await admin.fill('form[action$="/extra-round"] [name=rating]', '70.5');
    await admin.fill('form[action$="/extra-round"] [name=slope]', '125');
    await admin.fill('form[action$="/extra-round"] [name=par]', '72');
    await click(admin, 'form[action$="/extra-round"] button[type=submit]');
  }
  db = ro();
  const patNow = db.prepare('SELECT handicap_index FROM users WHERE id=?').get(patBefore.id).handicap_index;
  db.close();
  assert.ok(patNow < 20, `index should now be recalculated (best-of-3 table) — got ${patNow}`);
  patAfter.handicap_index = patNow;
  ok(`two general-play rounds added -> WHS index recalculated: 20.0 -> ${patNow}`);

  await go(captain, `/players/${patBefore.id}`);
  const prof = await captain.innerText('body');
  match(prof, new RegExp(patAfter.handicap_index.toFixed(1).replace(".", "\\.")));
  assert.ok(await captain.locator('svg[role=img], svg.spark, figure svg').count() > 0, 'handicap trend chart renders');
  ok('profile shows the new index, history and trend chart');

  await go(captain, '/standings');
  const st = await captain.innerText('body');
  match(st, /Player 59/);
  ok('Player 59 appears in the Order of Merit and handicap leaderboard');
  await go(captain, '/');
  match(await captain.innerText('body'), /Player 59/);
  ok('latest-results feed on the home page shows the new result');

  // ---- 6. Awards ---------------------------------------------------------------------------------
  await go(admin, '/admin/awards');
  await admin.fill('[name=name]', 'Pink Socks of the Year');
  await admin.fill('#t-d', 'For services to colour');
  await click(admin, 'button:has-text("Create award")');
  match(await admin.innerText('body'), /Pink Socks of the Year/);
  ok('admin creates a new award type');
  await admin.selectOption('#g-t', { label: 'Pink Socks of the Year' });
  await admin.selectOption('#g-u', { label: PAT.name });
  await admin.fill('#g-c', 'Debut win in a pair of flamingo-pink socks.');
  await click(admin, 'button:has-text("Give award")');
  await go(admin, '/awards');
  const aw = await admin.innerText('body');
  match(aw, /Pink Socks of the Year/);
  match(aw, /flamingo-pink socks/);
  ok('award granted for the current season and visible publicly');
  await go(admin, `/players/${patBefore.id}`);
  match(await admin.innerText('body'), /Pink Socks of the Year/);
  ok('award appears on the winner’s profile');

  // ---- 7. Season close -> roll of honour ---------------------------------------------------------
  await go(admin, '/admin/seasons');
  const closeBtn = admin.locator('form', { hasText: 'Save season' }).filter({ has: admin.locator('input[name=name][value="2026"]') }).locator('button:has-text("Close")');
  await Promise.all([admin.waitForNavigation({ waitUntil: 'domcontentloaded' }), closeBtn.first().click()]);
  db = ro();
  const champ = db.prepare("SELECT h.*, c.name cat FROM honours h JOIN honour_categories c ON c.id=h.category_id WHERE h.year=2026 AND c.kind='oom'").get();
  const s26 = db.prepare("SELECT status FROM seasons WHERE year=2026").get();
  db.close();
  assert.equal(s26.status, 'closed');
  assert.ok(champ, 'Order of Merit champion recorded for 2026');
  await go(admin, '/honours?year=2026');
  match(await admin.innerText('body'), /Society Champion/);
  ok('closing the season crowns the Order of Merit champion on the roll of honour');

  // ---- 8. Permissions sanity through the UI ------------------------------------------------------
  const m = await session();
  await login(m, ACCOUNTS.member);
  const r = await m.goto(srv.base + '/admin/members');
  assert.equal(r.status(), 403);
  ok('ordinary member gets 403 on admin pages');

  assert.deepEqual(problems, [], 'browser problems:\n' + problems.join('\n'));
  ok('no JS errors, console errors or 5xx responses during the whole run');
  console.log(`\nE2E PASSED (${step} checks)`);
} catch (e) {
  console.error('\nE2E FAILED:', e.message);
  if (problems.length) console.error('browser problems:', problems);
  console.error(srv.log().split('\n').slice(-15).join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
  await srv.stop();
}
