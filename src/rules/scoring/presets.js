'use strict';
/**
 * Season scoring (Order of Merit) modules. Each turns config options into the points scheme the
 * engine stores in `oom_default_scheme` (see lib/points parseScheme).
 */
module.exports = {
  'stableford-best-n': {
    label: 'Stableford scores, best N count, countback',
    scheme: ({ bestN = 7, countback = true } = {}) => ({ mode: 'score', positions: [30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1], participation: 0, bestN, countback }),
  },
  'position-points': {
    label: 'Points by finishing position (+ participation)',
    scheme: ({ positions = [30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1], participation = 5, bestN = null, countback = false } = {}) => ({ positions, participation, bestN, countback }),
  },
};
