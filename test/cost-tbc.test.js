'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('../src/lib/view-helpers');
test('event cost: unknown shows TBC, never Free', () => {
  for (const v of [null, undefined, 0, '']) assert.equal(h.money(v), 'TBC');
  assert.equal(h.money(8000), '£80'); assert.equal(h.money(2550), '£25.50');
});
