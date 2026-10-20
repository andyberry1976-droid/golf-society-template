# Golf Society Template

A white-label golf society website. Each society sets up **any competition format and scoring** in the admin;
everything (members, courses, competition rules, scores, results, leagues) is stored in a SQLite database.

## What's in it
- **Scoring engine** (`src/lib/scoring/`, pure functions, unit tested): Stableford, net/gross strokeplay, par/bogey,
  Texas scramble (team handicap weights), better-ball pairs, matchplay; handicap allowance %, max net double bogey,
  countback (back 9/6/3/1); points tables, points for playing, bonuses (playing, per birdie, scoring N+), last-place penalty.
- **Competition types**: start from a preset, edit in a form, saved as JSON config.
- **Events**: any competition type on a date at a course. **Scores** hole-by-hole *or* round totals.
- **Results** are calculated and stored with a **snapshot of the rules used**, so editing a competition type later never rewrites history.
- **Leagues**: pick which competition types / dates count and "best N" scores.
- **Branding**: society name, tagline, two colours and logo URL from Admin → Society branding.
- Every table has `society_id` (ready for multi-society / Postgres later).

## Run locally
```bash
npm install
npm run seed     # optional: fills an EMPTY database with a made-up demo society
npm start        # http://localhost:3000 — prints a one-time admin password on first start
```

## How to clone for a new client
1. On GitHub: **Use this repo as a template** (or `git clone` it) into a new **private** repo, e.g. `client-name-golf`.
2. `npm install`. Don't run the demo seed for a real client.
3. Set environment variables on the host:
   - `NODE_ENV=production`
   - `ADMIN_EMAIL=` the client's admin email
   - `ADMIN_PASSWORD=` a **new unique** password (12+ characters). The app refuses to start for the first time in production without one, and refuses known demo passwords.
   - `DATABASE_PATH=` a path on a persistent disk (default `data/society.db`).
4. Start it (`npm start`), log in at `/login`, then in **Admin**:
   - Society branding → name, colours, logo URL.
   - Add courses (18 pars + stroke indexes for hole-by-hole scoring), then members with handicap indexes.
   - Competition types → pick presets, adjust allowance/points/bonuses.
   - Leagues → e.g. "Order of Merit", choose which competitions count.
   - Events → add fixtures; after the round use **Enter scores** → results and league tables update.
5. Back up by copying the SQLite file (`DATABASE_PATH`) regularly.

## Tests
`npm test`
