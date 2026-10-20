'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { seedDemo } = require('../scripts/seed-demo-site');
const { startApp, Client } = require('./helpers');
const H = require('../src/lib/view-helpers');

test('season pickers offer every year up to this year + 5; saving a future year creates its season', async () => {
  const y = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(new Date()));
  const opts = H.seasonOptions([{ id: 1, name: String(y), year: y }]);
  assert.deepEqual(opts.map((o) => o.year), [y + 5, y + 4, y + 3, y + 2, y + 1, y]);
  const db = open(':memory:'); seedDemo(db);
  const app = await startApp(db);
  try {
    const adm = new Client(app.base); await adm.login('admin@example.test', 'flamingo-demo-1');
    for (const p of ['/admin/events/new', '/admin/tournaments', '/admin/matchplay']) {
      const t = (await adm.get(p)).text_;
      assert.match(t, new RegExp(`value="new:${y + 5}"`), p); assert.match(t, new RegExp(`${y + 1} \\(new season\\)|<option value="\\d+"[^>]*>${y + 1}<`), p);
    }
    const course = db.prepare('SELECT id FROM courses LIMIT 1').get().id;
    const fy = y + 3;
    const r = await adm.post('/admin/events', { title: 'Future Stableford', season_id: 'new:' + fy, course_id: course, event_date: `${fy}-04-10`, tee_time: '09:30', format: 'stableford', scoring_basis: 'stableford', cost: '', capacity: '', notes: '', counts_handicap: '1', counts_oom: '1', points_multiplier: '1', allowance_pct: '95' });
    assert.equal(r.status, 302);
    const s = db.prepare('SELECT * FROM seasons WHERE year=?').all(fy); assert.equal(s.length, 1);
    assert.equal(db.prepare("SELECT season_id FROM events WHERE title='Future Stableford'").get().season_id, s[0].id);
    const again = await adm.post('/admin/events', { title: 'Future Two', season_id: 'new:' + fy, course_id: course, event_date: `${fy}-05-10`, tee_time: '09:30', format: 'stableford', scoring_basis: 'stableford', counts_handicap: '1', counts_oom: '1', points_multiplier: '1', allowance_pct: '95' });
    assert.equal(again.status, 302); assert.equal(db.prepare('SELECT COUNT(*) n FROM seasons WHERE year=?').get(fy).n, 1, 'reuses the season');
  } finally { await app.close(); }
});
