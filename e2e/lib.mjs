// Shared helpers for the Playwright e2e + screenshot scripts.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';

export const DEMO_PASSWORD = 'flamingo-demo-1';
export const ACCOUNTS = {
  admin: 'admin@example.test',
  captain: 'captain@example.test',
  member: 'member@example.test',
};

export function chromePath() {
  for (const p of [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'])
    if (p && existsSync(p)) return p;
  throw new Error('No Chrome/Chromium found. Set CHROME_PATH=/path/to/chrome (or run `npx playwright-core install chromium`).');
}

export async function launch() {
  return chromium.launch({ executablePath: chromePath(), args: ['--no-sandbox'] });
}

/** Seed a throwaway DB and start the app on `port`. Returns { base, stop, dbPath }. */
export async function startServer({ port = 3199, dbPath = '/tmp/fairway-e2e.db', seed = true } = {}) {
  const env = { ...process.env, PORT: String(port), DATABASE_PATH: dbPath, NODE_ENV: 'development', SESSION_SECRET: 'e2e-secret', BCRYPT_ROUNDS: '4' };
  if (seed) {
    await new Promise((res, rej) => {
      const p = spawn('node', ['scripts/seed.js', '--reset', ...(process.env.E2E_SEED === 'demo' ? [] : ['--demo'])], { env, stdio: 'ignore' });
      p.on('exit', (c) => (c === 0 ? res() : rej(new Error('seed failed ' + c))));
    });
  }
  const child = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => (log += d));
  child.stderr.on('data', (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(base + '/healthz')).ok) break; } catch {}
    await sleep(250);
    if (i === 59) throw new Error('server did not start:\n' + log);
  }
  return { base, dbPath, log: () => log, stop: () => new Promise((r) => { child.on('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 3000); }) };
}
