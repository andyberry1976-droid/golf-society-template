'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const E = require('../src/lib/scoring');
const holes = Array.from({ length: 18 }, (_, i) => ({ par: [4, 3, 5][i % 3], si: i + 1 })); const course = { par: 72, rating: 71, slope: 130, holes };
test('allowances', () => {
  assert.equal(E.playingHandicap(E.courseHandicap(15, course), 95), 15);
  assert.equal(E.teamHandicap([20, 4, 12, 8], [0.25, 0.2, 0.15, 0.1]), 6);
  assert.equal(E.strokesOnHole(20, 2), 2); assert.equal(E.strokesOnHole(20, 3), 1); assert.equal(E.strokesOnHole(-2, 18), -1);
  assert.equal(E.capHole(9, 4, 1, { type: 'net_double_bogey' }), 7);
});
test('formats', () => {
  const s = E.scoreCard({ holes: holes.map((h) => h.par) }, course, 18);
  assert.equal(s.stableford, 54); assert.equal(s.net, 54); assert.equal(s.parBogey, 18);
  assert.deepEqual(E.scoreCard({ total: { gross: 88 } }, course, 15).stableford, 35);
  const a = E.scoreCard({ holes: holes.map((h, i) => h.par + (i % 2)) }, course, 0); const b = E.scoreCard({ holes: holes.map((h, i) => h.par + ((i + 1) % 2)) }, course, 0);
  assert.equal(E.betterBall([a, b]).stableford, 36);
  assert.equal(E.matchplay([3, 4, 4, 4], [4, 4, 4, 4]).label, '1 up'); assert.equal(E.matchplay([3, 3, 4, 4], [4, 4, 4, 4]).label, '2&1');
});
test('ranking + countback + override', () => {
  const back = (n) => holes.map((_, i) => ({ pts: i >= 9 ? n : 2 }));
  const r = E.rank([{ key: 'a', value: 36, holes: back(2) }, { key: 'b', value: 36, holes: back(3) }, { key: 'c', value: 30 }], { tieBreak: 'countback' });
  assert.deepEqual([r.get('b'), r.get('a'), r.get('c')], [1, 2, 3]);
  assert.equal(E.rank([{ key: 'a', value: 1, position_in: 4 }]).get('a'), 4);
});
test('points + bonuses + league', () => {
  const cfg = { mode: 'points', positions: [25, 18, 15], participation: 0, bonuses: [{ when: 'played', pts: 3 }, { when: 'birdies', pts: 2 }, { when: 'stableford>=36', pts: 3 }, { when: 'last', pts: -5 }] };
  const out = E.scoreEvent([{ key: 1, stableford: 40, birdies: 2 }, { key: 2, stableford: 30 }, { key: 3, stableford: 20 }], null, { format: 'stableford', points: cfg });
  assert.deepEqual(out.map((o) => o.points), [35, 21, 13]);
  assert.deepEqual(E.leagueTable([{ user: 1, event: 1, points: 10 }, { user: 1, event: 2, points: 5 }, { user: 2, event: 1, points: 12 }], { bestN: 1 }).map((r) => r.user), [2, 1]);
  assert.equal(E.normalise({ allowance: { pct: 900 } }).allowance.pct, 100);
});
