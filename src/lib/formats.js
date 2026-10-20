'use strict';
const FORMATS = [
  { key: 'stableford', label: 'Stableford', basis: 'stableford', hcp: 1, cls: 'f-stable' },
  { key: 'medal', label: 'Stroke play (net medal)', basis: 'stroke_net', hcp: 1, cls: 'f-stable' },
  { key: 'gross', label: 'Stroke play (gross scratch)', basis: 'stroke_gross', hcp: 1, cls: 'f-stable' },
  { key: 'scramble', label: 'Texas scramble', basis: 'manual', hcp: 0, cls: 'f-scramble' },
  { key: 'matchplay', label: 'Matchplay', basis: 'manual', hcp: 0, cls: 'f-match' },
  { key: 'foursomes', label: 'Foursomes / greensomes', basis: 'manual', hcp: 0, cls: 'f-four' },
  { key: 'fourball', label: 'Four-ball betterball', basis: 'manual', hcp: 0, cls: 'f-four' },
  { key: 'other', label: 'Other / fun format', basis: 'manual', hcp: 0, cls: 'f-match' },
];
const byKey = Object.fromEntries(FORMATS.map((f) => [f.key, f]));
const BASES = [
  { key: 'stableford', label: 'Stableford points (highest wins)' },
  { key: 'stroke_net', label: 'Net strokes (lowest wins)' },
  { key: 'stroke_gross', label: 'Gross strokes (lowest wins)' },
  { key: 'manual', label: 'Positions typed in by hand (matchplay, scramble…)' },
];
module.exports = { FORMATS, BASES, byKey, formatInfo: (k) => byKey[k] || byKey.other };
