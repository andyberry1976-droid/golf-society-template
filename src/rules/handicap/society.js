'use strict';
/**
 * "Society" handicap module (the Demo spreadsheet rules): buffer zone + category cuts per point,
 * 40+ cut, winner's cuts. Configured by the `society_hcp` setting (see lib/society DEFAULT_SOCIETY_HCP).
 */
const H = require('../../lib/handicap');
const Soc = require('../../lib/society');

module.exports = {
  id: 'society',
  label: 'Society rules (buffer, category cuts, winner cuts)',
  usesGeneralPlay: false,
  options: (S) => Soc.parseSocietyHcp(S.society_hcp),
  // eslint-disable-next-line global-require
  context: (db, S) => require('../../lib/engine').societyContext(db, Soc.parseSocietyHcp(S.society_hcp)),
  /** One event result. `st` = { current, hist, startIdx, maxIndex, cfg, ctx, userId }. Returns the result's derived fields. */
  onResult(st, r, date) {
    const course = r.par ? { par: r.par, rating: r.rating, slope: r.slope } : { par: 72, rating: 72, slope: 113 };
    const idx = st.current != null ? st.current : st.startIdx;
    const ph = Soc.playingFromIndex(idx);
    const stable = r.stableford_in != null ? r.stableford_in : (r.gross != null ? H.stablefordFromGross(r.gross, course.par, ph) : null);
    let ags = r.adjusted_gross != null ? r.adjusted_gross : r.gross;
    if (ags == null && stable != null) ags = H.grossFromStableford(stable, course.par, ph);
    const net = (r.gross != null ? r.gross : ags) != null ? H.netScore(r.gross != null ? r.gross : ags, ph) : null;
    if (r.counts_handicap && r.ev_status === 'completed' && stable != null) {
      const c = st.ctx.get(r.event_id);
      const winnerCut = c && c.winners.has(st.userId) ? c.winnerCut : 0;
      const a = Soc.applySociety(idx, stable, { winnerCut, cfg: st.cfg });
      const before = st.current;
      st.current = Math.min(st.maxIndex, a.index);
      st.hist.push({ effective_on: date, index_before: before, index_after: st.current, source: 'event', result_id: r.id, label: `${r.title} · ${stable} pts${a.parts.length ? ' (' + a.parts.join(', ') + ')' : ''}` });
    }
    return { idx, ch: ph, ph, ags, stable, net, diff: null };
  },
};
