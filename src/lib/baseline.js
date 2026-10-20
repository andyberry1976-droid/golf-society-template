'use strict';
/** Starter data every fresh install needs: trophies, award types and an open season. */
const AWARD_TYPES = [
  ['Wooden Spoon', 's-spoon', '#ffe9c7', 'For finishing last so consistently we named the trophy after it.', 'wooden_spoon'],
  ['Sandbagger of the Year', 's-bow', '#e6defa', 'Handicap says 21. Scorecard says 11.', 'sandbagger'],
  ['Mr Consistency', 's-star', '#fff3b8', 'Shot the same score again and again.', 'consistency'],
  ['Best Dressed', 's-bow', '#fde1f2', 'Style over substance. Pink optional.', null],
  ['Longest Drive', 's-drive', '#d9fbe9', 'Found the ball in the next postcode.', null],
  ['Nearest the Pin', 's-pin', '#e6defa', 'Closest to the flag over the season.', null],
  ['Comeback Kid', 's-up', '#d9fbe9', 'Biggest handicap drop of the season.', 'most_improved'],
  ['Biggest Moaner', 's-moan', '#fde1f2', 'Blamed the wind, the greens and a passing pigeon.', null],
  ['Lost Ball King', 's-lost', '#fff3b8', 'Fed the pond more than the ducks.', null],
  ['Sand Castle Award', 's-sand', '#ffe9c7', 'More time in bunkers than a beach donkey.', null],
  ['Most Mulligans', 's-ball', '#e6defa', 'It was only a practice swing. Every tee shot.', null],
  ['Spirit of the Society', 's-heart', '#fde1f2', 'Always has a spare ball, a plaster and a kind word.', null],
];

function seedBase(db, { year = new Date().getFullYear() } = {}) {
  db.transaction(() => {
    const cat = db.prepare('INSERT OR IGNORE INTO honour_categories(name,kind,sort) VALUES (?,?,?)');
    [['Spring Opener', 'event'], ["Captain's Day", 'event'], ['Matchplay Cup', 'event'], ['Society Champion', 'oom'], ['Winter Foursomes', 'event']]
      .forEach((c, i) => cat.run(c[0], c[1], i + 1));
    const aw = db.prepare('INSERT OR IGNORE INTO award_types(name,icon,tint,description,rule,sort) VALUES (?,?,?,?,?,?)');
    AWARD_TYPES.forEach((a, i) => aw.run(a[0], a[1], a[2], a[3], a[4], i + 1));
    if (!db.prepare('SELECT 1 FROM seasons').get()) {
      db.prepare('INSERT INTO seasons(name,year,start_date,end_date) VALUES (?,?,?,?)').run(String(year), year, `${year}-01-01`, `${year}-12-31`);
    }
  })();
}

module.exports = { seedBase, AWARD_TYPES };
