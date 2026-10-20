'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { setup, validateAnswers } = require('../scripts/setup-society');

test('setup answers are validated', () => {
  assert.throws(() => validateAnswers({}), /society_name/);
  assert.throws(() => validateAnswers({ society_name: 'X GS', colors: { primary: 'red' } }), /colors.primary/);
  assert.throws(() => validateAnswers({ society_name: 'X GS', features: { nope: true } }), /unknown feature/);
  assert.throws(() => validateAnswers({ society_name: 'X GS', competition_presets: ['bogus'] }), /unknown preset/);
  assert.equal(validateAnswers({ society_name: 'The Sunny Hackers Golf Society' }), 'sunny-hackers-golf-society');
});

test('new-society builds a configured copy: no demo site, branding, features, presets, seasons, members CSV, env example', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gs-setup-'));
  const csv = path.join(tmp, 'members.csv'); fs.writeFileSync(csv, 'name,email,handicap\nPlayer 92,player59@example.test,12.4\nPlayer 93,,20\n');
  const out = path.join(tmp, 'club');
  const r = await setup({ society_name: 'The Sunny Hackers', slug: 'sunny', domain: 'sunny.example', admin_email: 'admin2@sunny.example', colors: { primary: '#123456' },
    features: { fantasy: false, birthdays: true }, competition_presets: ['stableford', 'matchplay'], season_start_year: 2024, members_csv: csv }, { out });
  assert.ok(!fs.existsSync(path.join(out, 'sites', 'demo')));
  const cfg = JSON.parse(fs.readFileSync(path.join(out, 'sites', 'sunny', 'site.config.json'), 'utf8'));
  assert.equal(cfg.name, 'The Sunny Hackers'); assert.equal(cfg.branding.colors.primary, '#123456'); assert.equal(cfg.features.fantasy, false); assert.equal(cfg.features.engine, true);
  assert.notEqual(cfg.settings.invite_code, 'CHANGEME');
  const env = fs.readFileSync(path.join(out, '.env.example'), 'utf8'); assert.match(env, /SITE=sunny/); assert.match(env, /ADMIN_EMAIL=admin2@sunny.example/); assert.doesNotMatch(env, /ADMIN_PASSWORD=\S+\s*$/m);
  assert.equal(r.built.competition_types, 2); assert.ok(r.built.seasons >= 3); assert.ok(r.built.members >= 2);
  fs.rmSync(tmp, { recursive: true, force: true });
});
