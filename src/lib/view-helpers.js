'use strict';
const H = require('./handicap');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const FULL_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const parts = (iso) => { const [y, m, d] = iso.split('-').map(Number); const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); return { y, m, d, dow }; };

const AVC = [['#d4168f', '#fff'], ['#0a7a55', '#fff'], ['#ffd23f', '#23123b'], ['#6d28d9', '#fff'], ['#ff9f43', '#23123b'], ['#38bdf8', '#23123b'], ['#a3e635', '#23123b'], ['#ff6b6b', '#23123b']];

/** Server-rendered handicap sparkline (higher on the chart = better = lower index). */
function spark(values, gid) {
  const t = values.slice(-30);
  if (t.length < 2) return '';
  const W = 300; const Hh = 96; const pad = 10;
  const mn = Math.min(...t); const mx = Math.max(...t); const rg = (mx - mn) || 1;
  const pts = t.map((v, i) => [pad + i * (W - 2 * pad) / (t.length - 1), pad + (v - mn) / rg * (Hh - 2 * pad)]);
  const line = pts.map((q, i) => (i ? 'L' : 'M') + q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('');
  const area = line + 'L' + pts[pts.length - 1][0].toFixed(1) + ' ' + Hh + 'L' + pts[0][0].toFixed(1) + ' ' + Hh + 'Z';
  const last = pts[pts.length - 1];
  const dots = pts.map((q) => `<circle cx="${q[0].toFixed(1)}" cy="${q[1].toFixed(1)}" r="3" fill="#fff" stroke="#6d28d9" stroke-width="2"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${Hh}" role="img" aria-label="Handicap index over the last ${t.length} changes: from ${t[0].toFixed(1)} to ${t[t.length - 1].toFixed(1)}"><defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6d28d9" stop-opacity=".35"/><stop offset="1" stop-color="#6d28d9" stop-opacity="0"/></linearGradient></defs><path d="${area}" fill="url(#${gid})"/><path d="${line}" fill="none" stroke="#6d28d9" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>${dots}<circle cx="${last[0].toFixed(1)}" cy="${last[1].toFixed(1)}" r="6" fill="#d4168f" stroke="#23123b" stroke-width="2.5"/></svg>`;
}

module.exports = {
  spark,
  monthShort: (iso) => MONTHS[parts(iso).m - 1],
  dayNum: (iso) => parts(iso).d,
  dowShort: (iso) => DAYS[parts(iso).dow],
  dateLong: (iso) => { const p = parts(iso); return `${FULL_DAYS[p.dow]} ${p.d} ${FULL_MONTHS[p.m - 1]}`; },
  dateLongY: (iso) => { const p = parts(iso); return `${FULL_DAYS[p.dow]} ${p.d} ${FULL_MONTHS[p.m - 1]} ${p.y}`; },
  dateShort: (iso) => { const p = parts(iso); return `${p.d} ${MONTHS[p.m - 1]} ${p.y}`; },
  money: (pence, cur = '£') => (pence ? `${cur}${(pence / 100).toFixed(pence % 100 ? 2 : 0)}` : 'TBC'), // no cost recorded = not known yet (there is no separate 'free' flag)
  initials: (name) => { const w = String(name || '?').trim().split(/\s+/); return ((w[0][0] || '?') + (w.length > 1 ? w[w.length - 1][0] : '')).toUpperCase(); },
  avatarStyle: (id) => { const c = AVC[(id || 0) % AVC.length]; return `background:${c[0]};color:${c[1]}`; },
  fmtIdx: H.formatIndex,
  // award/record icon: a preset SVG symbol id ("s-trophy") or an emoji chosen by the admin
  iconHtml: (icon, style = '') => {
    const s = String(icon || 's-trophy');
    if (/^s-[a-z0-9-]+$/.test(s)) return `<svg class="ic" viewBox="0 0 48 48" aria-hidden="true"${style ? ` style="${style}"` : ''}><use href="#${s}"/></svg>`;
    const esc = s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    return `<span class="emo" aria-hidden="true" style="display:inline-block;line-height:1;font-size:1.25em${style ? ';' + style : ''}">${esc}</span>`;
  },
  sgn: (n) => (n == null ? '' : (n < 0 ? '−' : n > 0 ? '+' : '±') + Math.abs(n).toFixed(1)),
  ordinal: (n) => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th'),
  /** Season dropdown: existing seasons plus every year up to this year + 5 that has none yet ("new:YYYY", created on save). */
  seasonOptions: (seasons, ahead = 5) => {
    const y0 = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric' }).format(new Date()));
    const have = new Set((seasons || []).map((s) => Number(s.year)));
    const extra = []; for (let y = y0; y <= y0 + ahead; y++) if (!have.has(y)) extra.push({ id: 'new:' + y, name: y + ' (new season)', year: y });
    return [...extra.reverse(), ...(seasons || [])].sort((a, b) => b.year - a.year);
  },
  roleLabel: (r) => ({ admin: 'Admin', captain: 'Captain', member: 'Member' }[r] || r),
};
