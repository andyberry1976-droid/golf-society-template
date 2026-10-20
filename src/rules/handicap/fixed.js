'use strict';
/**
 * "Fixed" (manual) handicap module: each player has ONE handicap, played off as-is on every course.
 * - No course/slope/rating conversion: playing handicap = the handicap rounded to a whole number
 *   (the spreadsheet's "playing" column), on every course.
 * - Results NEVER change the handicap. Only an admin changes it (Admin → Members → Set handicap),
 *   which is stored as a manual adjustment and so appears in the handicap history and the audit log.
 * Par is still used to estimate stableford points when only a gross score is entered.
 */
const H = require('../../lib/handicap');

module.exports = {
  id: 'fixed',
  label: 'Fixed handicap, set by the admin (no automatic changes)',
  usesGeneralPlay: false,
  manual: true,
  options: () => ({}),
  context: () => null,
  onResult(st, r) {
    const idx = st.current != null ? st.current : st.startIdx;
    const ph = idx == null ? null : Math.round(idx + 1e-9);
    const par = r.par || 72;
    const stable = r.stableford_in != null ? r.stableford_in : (r.gross != null ? H.stablefordFromGross(r.gross, par, ph) : null);
    let ags = r.adjusted_gross != null ? r.adjusted_gross : r.gross;
    if (ags == null && stable != null) ags = H.grossFromStableford(stable, par, ph);
    const g = r.gross != null ? r.gross : ags;
    const net = g != null ? H.netScore(g, ph) : null;
    return { idx, ch: ph, ph, ags, stable, net, diff: null };
  },
};
