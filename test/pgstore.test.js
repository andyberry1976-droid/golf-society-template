'use strict';
// Runs against a real Postgres when TEST_DATABASE_URL is set (e.g. a local cluster); skipped otherwise.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const URL_ = process.env.TEST_DATABASE_URL;

function boot(env) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => reject(new Error('boot timeout\n' + out)), 30000);
    const on = (d) => { out += d; if (/listening on/.test(out)) { clearTimeout(t); resolve({ p, log: () => out }); } };
    p.stdout.on('data', on); p.stderr.on('data', on);
    p.on('exit', (c) => { clearTimeout(t); if (!/listening on/.test(out)) reject(new Error('exited ' + c + '\n' + out)); });
  });
}
const stop = (s) => new Promise((r) => { s.p.on('exit', r); s.p.kill('SIGTERM'); });

test('postgres persistence: seeds once, keeps admin edits and logins across restarts', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async () => {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: URL_ });
  await pool.query('DROP TABLE IF EXISTS app_snapshots, app_meta');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgt-'));
  const env = { DATABASE_URL: URL_, DATABASE_PATH: path.join(dir, 'w.db'), PORT: '3291', SESSION_SECRET: 'test-secret-123', BCRYPT_ROUNDS: '4', NODE_ENV: 'development' };
  const { Client } = require('./helpers');
  const base = 'http://127.0.0.1:3291';
  try {
    let s = await boot(env);
    assert.match(s.log(), /Postgres is empty/); assert.match(s.log(), /seeded the Demo/);
    const adm = new Client(base); await adm.login('admin@example.test', 'flamingo-demo-1');
    let h = await adm.get('/handicaps'); assert.equal(h.status, 200); assert.match(h.text_, /Player 1/);
    // an admin edit: rename the society
    const page = await adm.get('/admin/settings'); assert.equal(page.status, 200);
    const db0 = s; void db0;
    const r = await adm.post('/admin/settings', { society_name: 'The Demo PG', short_name: 'Demo PG', hero_title: 'The Demo', currency: '£', default_allowance: '95', max_index: '54', default_start_index: '28', positions: '30, 24', oom_mode: 'score', best_n: '7', countback: '1', participation: '0' });
    assert.equal(r.status, 302);
    await stop(s); // SIGTERM flushes
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); // simulate Render wiping its disk
    s = await boot(env);
    assert.match(s.log(), /Loaded data from Postgres/); assert.doesNotMatch(s.log(), /seeded/);
    const home = await adm.get('/'); // same cookie, new process
    assert.match(home.text_, /Demo PG/);
    assert.match(home.text_, /My account/, 'login survived the restart');
    const ev = await adm.get('/events'); assert.doesNotMatch(ev.text_, /spaces left/i); // RSVP still off
    const snaps = (await pool.query('SELECT COUNT(*)::int n FROM app_snapshots')).rows[0].n; assert.ok(snaps >= 2);
    await stop(s);
  } finally { await pool.end(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('server starts on SQLite when Postgres is unreachable', { skip: !URL_ && 'set TEST_DATABASE_URL to run' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgt-'));
  const s = await boot({ DATABASE_URL: 'postgres://u:p@127.0.0.1:1/x', DATABASE_PATH: path.join(dir, 'w.db'), PORT: '3292', BCRYPT_ROUNDS: '4', NODE_ENV: 'development' });
  assert.match(s.log(), /Could not reach Postgres/); assert.doesNotMatch(s.log(), /u:p@/);
  const r = await fetch('http://127.0.0.1:3292/healthz'); assert.equal(r.status, 200);
  await stop(s); fs.rmSync(dir, { recursive: true, force: true });
});
