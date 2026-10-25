'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { open, setSetting, getSettings, DEFAULT_SETTINGS } = require('../src/db');
const { isPlaceholderBlurb } = require('../src/site');
const users = require('../src/lib/users');
const { startApp, Client } = require('./helpers');

test('footer: the starter "Rebrand me" text is replaced on start and never shown to the public', async () => {
  assert.equal(isPlaceholderBlurb('Your Golf Society. Rebrand me in Admin → Settings.'), true);
  assert.equal(isPlaceholderBlurb(DEFAULT_SETTINGS.footer_blurb), false, 'the site config has real footer text');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'foot-')), 'f.db');
  let db = open(file);
  setSetting(db, 'footer_blurb', 'Your Golf Society. Rebrand me in Admin → Settings.'); db.close();
  db = open(file); assert.equal(getSettings(db).footer_blurb, DEFAULT_SETTINGS.footer_blurb, 'stored placeholder replaced');
  setSetting(db, 'footer_blurb', 'Our own words'); db.close();
  db = open(file); assert.equal(getSettings(db).footer_blurb, 'Our own words', 'a real footer is left alone');
  // even if a placeholder is stored, the public never sees it; admins get a pointer to Settings
  setSetting(db, 'footer_blurb', 'Rebrand me in Admin → Settings.');
  const id = users.createUser(db, { name: 'Foot Admin', email: 'foot-admin@t.example', passwordHash: users.hashPassword('password-123'), index: 18, joinedOn: '2025-01-01' });
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(id);
  const app = await startApp(db);
  try {
    const anon = new Client(app.base); const adm = new Client(app.base); await adm.login('foot-admin@t.example');
    let r = await anon.get('/'); assert.equal(r.status, 200); assert.doesNotMatch(r.text_, /Rebrand me/); assert.doesNotMatch(r.text_, /set your footer text/);
    r = await adm.get('/'); assert.doesNotMatch(r.text_, /Rebrand me/); assert.match(r.text_, /Admins: set your footer text in Admin → Settings/);
    setSetting(db, 'footer_blurb', 'Our own words');
    assert.match((await anon.get('/')).text_, /Our own words/);
  } finally { await app.close(); db.close(); }
});
