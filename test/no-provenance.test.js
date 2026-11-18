'use strict';
process.env.BCRYPT_ROUNDS = '4';
const test = require('node:test');
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { seedDemo } = require('../scripts/seed-demo-site');

test('public text carries no import/source notes (sheets, docs, placeholder dates, name matching)', () => {
  const db = open(':memory:'); seedDemo(db);
  const bad = /sheet|document|\.doc\b|placeholder|transcribed|matched to|imported|demo login/i;
  for (const [t, c] of [['events', 'notes'], ['users', 'bio'], ['tournaments', 'cut_note'], ['mp_comps', 'notes'], ['ryder_cups', 'notes'], ['honours', 'detail'], ['handicap_history', 'label']]) {
    for (const r of db.prepare(`SELECT ${c} v FROM ${t} WHERE ${c} IS NOT NULL`).all()) assert.doesNotMatch(r.v, bad, `${t}.${c}: ${r.v}`);
  }
});
