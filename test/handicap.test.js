'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/lib/handicap');

test('score differential = (113/slope) * (AGS - rating - PCC), 1dp', () => {
  assert.equal(H.scoreDifferential({ ags: 85, rating: 71.2, slope: 130 }), 12.0);
  assert.equal(H.scoreDifferential({ ags: 72, rating: 72, slope: 113 }), 0);
  assert.equal(H.scoreDifferential({ ags: 100, rating: 70, slope: 140 }), 24.2); // 113/140*30 = 24.214
  assert.equal(H.scoreDifferential({ ags: 80, rating: 72, slope: 113, pcc: 1 }), 7.0);
  assert.equal(H.scoreDifferential({ ags: 68, rating: 71.4, slope: 125 }), -3.1); // better than rating -> negative differential
  assert.throws(() => H.scoreDifferential({ ags: 80, rating: 72, slope: 0 }));
});

test('round1 rounds .5 up and tolerates float noise', () => {
  assert.equal(H.round1(12.25), 12.3);
  assert.equal(H.round1(12.2499), 12.2);
  assert.equal(H.round1(0.05), 0.1);
  assert.equal(H.round1(-0.25), -0.2);
  assert.equal(H.round1(8.1 + 0.2), 8.3);
});

test('WHS table: number of rounds -> lowest used & adjustment', () => {
  const expected = { 3: [1, -2], 4: [1, -1], 5: [1, 0], 6: [2, -1], 7: [2, 0], 8: [2, 0], 9: [3, 0], 10: [3, 0], 11: [3, 0], 12: [4, 0], 13: [4, 0], 14: [4, 0], 15: [5, 0], 16: [5, 0], 17: [6, 0], 18: [6, 0], 19: [7, 0], 20: [8, 0] };
  assert.deepEqual(H.WHS_TABLE, expected);
});

test('handicap index: null with fewer than 3 rounds', () => {
  assert.equal(H.indexFromDifferentials([]), null);
  assert.equal(H.indexFromDifferentials([10, 12]), null);
});

test('handicap index with 3..20 rounds follows the WHS table', () => {
  // 3 rounds: lowest 1 minus 2.0
  assert.equal(H.indexFromDifferentials([20, 15, 18]), 13.0);
  // 4 rounds: lowest 1 minus 1.0
  assert.equal(H.indexFromDifferentials([20, 15, 18, 22]), 14.0);
  // 5 rounds: lowest 1, no adjustment
  assert.equal(H.indexFromDifferentials([20, 15, 18, 22, 30]), 15.0);
  // 6 rounds: average lowest 2 minus 1.0 -> (15+18)/2 - 1 = 15.5
  assert.equal(H.indexFromDifferentials([20, 15, 18, 22, 30, 25]), 15.5);
  // 8 rounds: avg lowest 2
  assert.equal(H.indexFromDifferentials([10, 12, 14, 16, 18, 20, 22, 24]), 11.0);
  // 20 rounds, best 8 of 20: diffs 1..20 -> avg(1..8)=4.5
  const twenty = Array.from({ length: 20 }, (_, i) => 20 - i);
  assert.equal(H.indexFromDifferentials(twenty), 4.5);
  // 12 rounds: lowest 4
  assert.equal(H.indexFromDifferentials(Array.from({ length: 12 }, (_, i) => 10 + i)), 11.5);
});

test('only the most recent 20 differentials count', () => {
  const old = Array(5).fill(1.0); // five great old rounds that must fall away
  const recent = Array.from({ length: 20 }, (_, i) => 10 + i); // 10..29, best 8 avg = 13.5
  assert.equal(H.indexFromDifferentials([...old, ...recent]), 13.5);
});

test('index is capped at the maximum', () => {
  assert.equal(H.indexFromDifferentials(Array(20).fill(70)), 54);
  assert.equal(H.indexFromDifferentials(Array(20).fill(40), { maxIndex: 36 }), 36);
});

test('soft cap halves rises above low+3; hard cap stops at low+5', () => {
  assert.equal(H.applyCaps(12.0, 10.0), 12.0);          // +2 -> no cap
  assert.equal(H.applyCaps(14.0, 10.0), 13.5);          // +4 -> 13 + (1*0.5)
  assert.equal(H.applyCaps(18.0, 10.0), 15.0);          // +8 -> soft gives 15.5 -> hard cap 15.0
  assert.equal(H.applyCaps(14.0, 10.0, { soft: false, hard: true }), 14.0);
  assert.equal(H.applyCaps(18.0, 10.0, { soft: false, hard: true }), 15.0);
  assert.equal(H.applyCaps(14.0, 10.0, { soft: false, hard: false }), 14.0);
  assert.equal(H.applyCaps(14.0, null), 14.0);
  assert.equal(H.applyCaps(8.0, 10.0), 8.0);            // improvements never capped
});

test('course handicap = index * slope/113 + (rating - par)', () => {
  assert.equal(H.courseHandicap(15.0, { slope: 130, rating: 71.2, par: 72 }), 16);
  assert.equal(H.courseHandicap(0, { slope: 113, rating: 72, par: 72 }), 0);
  assert.equal(H.courseHandicap(20.0, { slope: 113, rating: 70, par: 72 }), 18);
  assert.equal(H.courseHandicap(10.4, { slope: 125, rating: 73.4, par: 72 }), 13); // 11.5+1.4=12.9
  assert.equal(H.courseHandicap(-2.0, { slope: 113, rating: 72, par: 72 }), -2);   // plus handicap
});

test('playing handicap applies the allowance and rounds', () => {
  assert.equal(H.playingHandicap(16, 95), 15);   // 15.2
  assert.equal(H.playingHandicap(10, 95), 10);   // 9.5 -> 10
  assert.equal(H.playingHandicap(18, 100), 18);
  assert.equal(H.playingHandicap(20, 85), 17);
  assert.equal(H.playingHandicap(0, 95), 0);
});

test('net and stableford conversions are consistent', () => {
  assert.equal(H.netScore(90, 15), 75);
  // playing exactly to handicap = 36 points
  assert.equal(H.stablefordFromGross(87, 72, 15), 36);
  assert.equal(H.stablefordFromGross(80, 72, 15), 43);
  assert.equal(H.stablefordFromGross(140, 72, 15), 0); // floored
  assert.equal(H.grossFromStableford(36, 72, 15), 87);
  assert.equal(H.grossFromStableford(40, 72, 15), 83);
  for (const pts of [20, 30, 36, 44]) assert.equal(H.stablefordFromGross(H.grossFromStableford(pts, 71, 12), 71, 12), pts);
});

test('formatIndex', () => {
  assert.equal(H.formatIndex(null), 'NH');
  assert.equal(H.formatIndex(12.34), '12.3');
  assert.equal(H.formatIndex(-1.2), '+1.2');
});
