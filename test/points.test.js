'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../src/lib/points');

const scheme = { positions: [30, 24, 20, 17], participation: 5, bestN: null };

test('points by position + participation (+ multiplier and bonus)', () => {
  assert.equal(P.pointsFor(1, scheme), 35);
  assert.equal(P.pointsFor(4, scheme), 22);
  assert.equal(P.pointsFor(9, scheme), 5);            // beyond the table: participation only
  assert.equal(P.pointsFor(null, scheme), 5);
  assert.equal(P.pointsFor(1, scheme, { multiplier: 2 }), 65);   // 60 + 5
  assert.equal(P.pointsFor(2, scheme, { multiplier: 1.5 }), 41); // 36 + 5
  assert.equal(P.pointsFor(3, scheme, { bonus: 3 }), 28);
});

test('parseScheme is defensive', () => {
  assert.deepEqual(P.parseScheme('{"positions":[10,5],"participation":2,"bestN":3}'), { mode: 'points', countback: false, positions: [10, 5], participation: 2, bestN: 3 });
  assert.deepEqual(P.parseScheme('garbage'), P.parseScheme(P.DEFAULT_SCHEME));
  assert.equal(P.parseScheme({ positions: [1], participation: -4 }).participation, 0);
  assert.equal(P.parseScheme({ positions: ['x', 5] }).positions[0], 0);
});

test('competition ranking handles ties (1,2,2,4)', () => {
  const r = P.rankValues([{ key: 'a', value: 40 }, { key: 'b', value: 38 }, { key: 'c', value: 38 }, { key: 'd', value: 30 }, { key: 'e', value: null }], { lower: false });
  assert.deepEqual([...r.entries()], [['a', 1], ['b', 2], ['c', 2], ['d', 4]]);
  const low = P.rankValues([{ key: 'a', value: 70 }, { key: 'b', value: 68 }], { lower: true });
  assert.equal(low.get('b'), 1);
});

test('best-N counting', () => {
  assert.deepEqual(P.bestN([10, 30, 20, 5], 2), { total: 50, counted: 2, dropped: 2, rest: [10, 5] });
  assert.deepEqual(P.bestN([10, 30], null), { total: 40, counted: 2, dropped: 0, rest: [] });
  assert.deepEqual(P.bestN([10, 30], 5), { total: 40, counted: 2, dropped: 0, rest: [] });
});
