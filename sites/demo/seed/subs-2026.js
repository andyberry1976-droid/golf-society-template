'use strict';
/**
 * 2026 subs from Admin's WhatsApp checklist (16 Oct 2026). Ticked = paid. The list was cropped at the top, so members
 * not listed here are left as they are. `as` is the name as written; `member` is who we matched it to.
 * Matches marked `check` are guesses Admin still has to confirm.
 */
const NOTE = 'WhatsApp checklist 16 Oct 2026';
const P = (as, member, check) => ({ as, member, paid: true, check: check || null });
const U = (as, member, check) => ({ as, member, paid: false, check: check || null });
const LIST = [
  P('P2', 'Player 2', 'P2 vs P22: assumed P2 = Player 2 (as on the matchplay sheets)'),
  P('P22', 'Player 22'),
  P('P31', 'Player 31'),
  U('P6', 'Player 6', 'P6 = Player 6 (nickname map)'),
  P('P35', 'Player 35'),
  P('Admin', 'Admin'),
  P('P16', 'Player 16', 'P16: Player 16 (active) assumed; Player 75 is a disabled past-season player'),
  U('P1', 'Player 1'),
  U('Player 26', 'Player 26'),
  P('P7', 'Player 7', 'P7: Player 7 assumed (Player 20 listed separately; Player 34 also a member)'),
  P('P20', 'Player 20'),
  U('P10', 'Player 10', 'P10 = Player 10 (nickname map)'),
  P('P5', 'Player 5', 'P5: Player 5 assumed (Player 35 is "P35")'),
  U('P21', 'Player 21', 'P21 = Player 21 (nickname map)'),
  P('P11', 'Player 11'),
  P('P4', 'Player 4', 'P4: tick faded at the top edge of the screenshot; treated as paid'),
  P('P15', 'Player 15'),
  P('P36', 'Player 36'),
  P('P17', 'Player 17'),
  P('Player 32', 'Player 32'),
  U('P3b', 'Player 3'),
  P('P33', 'Player 33'),
  P('P12', 'Player 12'),
  P('Player 23', 'Player 23'),
  P('P9', 'Player 9', 'P9 = Player 9 (only P9)'),
  P('P24', 'Player 24', 'P24: Player 24 assumed (also Player 89, Player 37)'),
  P('Player 25', 'Player 25'),
  P('Player 18', 'Player 18'),
  P('Player 28', 'Player 28'),
  U('Player 14', 'Player 14'),
  U('Player 27', 'Player 27'),
  P('Player 13', 'Player 13'),
];
module.exports = { SEASON: '2026', NOTE, LIST, entries: () => LIST.map((e) => ({ member: e.member, paid: e.paid, note: NOTE + (e.check && /faded/.test(e.check) ? ' (tick faded: check)' : '') })) };
