'use strict';
/** WHS-style handicap module: score differentials, best 8 of 20, soft/hard caps, course & playing handicaps. */
const H = require('../../lib/handicap');

function addDays(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

function addDiff(st, date, diff, entry) {
  st.diffs.push(diff);
  let calc = H.indexFromDifferentials(st.diffs, { maxIndex: st.maxIndex });
  const before = st.current;
  if (calc != null) {
    const from = addDays(date, -365);
    let low = null;
    for (const h of st.hist) if (h.effective_on > from && h.effective_on <= date) low = low == null ? h.index_after : Math.min(low, h.index_after);
    calc = H.applyCaps(calc, low, { soft: st.S.soft_cap === '1', hard: st.S.hard_cap === '1' });
    st.current = Math.min(st.maxIndex, calc);
  }
  if (st.current != null) st.hist.push({ ...entry, effective_on: date, index_before: before, index_after: st.current, differential: diff });
}

module.exports = {
  id: 'whs',
  label: 'WHS-style (differentials, best 8 of 20, caps)',
  usesGeneralPlay: true,
  options: () => ({}),
  context: () => null,
  onExtra(st, x, date) {
    const diff = H.scoreDifferential({ ags: x.ags, rating: x.rating, slope: x.slope });
    addDiff(st, date, diff, { source: 'extra', extra_id: x.id, label: x.course_name + ' (general play)' });
  },
  onResult(st, r, date) {
    const course = r.par ? { par: r.par, rating: r.rating, slope: r.slope } : { par: 72, rating: 72, slope: 113 };
    const idx = st.current != null ? st.current : st.startIdx;
    const ch = H.courseHandicap(idx, course);
    const ph = H.playingHandicap(ch, r.allowance_pct || st.allowDefault);
    let ags = r.adjusted_gross != null ? r.adjusted_gross : r.gross;
    if (ags == null && r.stableford_in != null) ags = H.grossFromStableford(r.stableford_in, course.par, ph);
    const stable = r.stableford_in != null ? r.stableford_in : (r.gross != null ? H.stablefordFromGross(r.gross, course.par, ph) : null);
    const grossForNet = r.gross != null ? r.gross : ags;
    const net = grossForNet != null ? H.netScore(grossForNet, ph) : null;
    let diff = null;
    if (r.counts_handicap && r.ev_status === 'completed' && ags != null) {
      diff = H.scoreDifferential({ ags, rating: course.rating, slope: course.slope });
      addDiff(st, date, diff, { source: 'event', result_id: r.id, label: r.title });
    }
    return { idx, ch, ph, ags, stable, net, diff };
  },
};
