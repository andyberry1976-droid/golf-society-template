'use strict';
/**
 * Switching a society's handicap module safely.
 * Going to the "fixed" (manual) module must not lose anything: handicaps that earlier results had
 * adjusted automatically are frozen into manual adjustments (same dates, same values, same labels),
 * so every player keeps their current handicap and their history reads the same afterwards.
 */
const { getSettings, setSetting } = require('../db');
const { recomputeAll } = require('./engine');
const Q = require('./queries');

const FROZEN = '[kept from auto-adjust] ';

function setHandicapMode(db, mode, { actorId = null, reason = '' } = {}) {
  const rules = require('../rules');
  if (!rules.HANDICAP[mode]) throw new Error(`Unknown handicap module ${mode}`);
  const S = getSettings(db);
  const from = rules.handicap(S.handicap_mode).id;
  if (S.handicap_mode === mode) return { changed: false, frozen: 0 };
  let frozen = 0;
  db.transaction(() => {
    if (rules.HANDICAP[mode].manual && !rules.HANDICAP[from].manual) {
      const ins = db.prepare("INSERT INTO handicap_adjustments(user_id,effective_on,index_value,kind,note,created_by) VALUES (?,?,?,'manual',?,?)");
      for (const h of db.prepare("SELECT * FROM handicap_history WHERE source IN ('event','extra') ORDER BY user_id, seq").all()) {
        ins.run(h.user_id, h.effective_on, h.index_after, (FROZEN + (h.label || h.source)).slice(0, 200), actorId); frozen++;
      }
    }
    setSetting(db, 'handicap_mode', mode);
    recomputeAll(db);
    Q.audit(db, actorId, 'set_handicap_mode', `${S.handicap_mode || '∅'} → ${mode}${frozen ? `; ${frozen} automatic adjustments kept as manual entries` : ''}${reason ? ` (${reason})` : ''}`);
  })();
  return { changed: true, frozen };
}

module.exports = { setHandicapMode, FROZEN };
