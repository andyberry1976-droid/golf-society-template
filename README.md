# Golf Society Template

A white-label golf society web app to clone for each new client: events & RSVPs, results, Order of Merit,
Birdie League, FedEx Cup, majors, matchplay, Texas scramble, Ryder Cup, fantasy league, handicaps, records,
honours, awards, birthdays, subs, Excel import/export, backups, and a **configurable competition engine**
(any format and scoring, hole-by-hole or totals, custom leagues). Every module can be switched on/off per society.

- **New client in one command:** `npm run new-society -- --config society.json --out ../client-golf`
  (answers documented in [SETUP-QUESTIONS.md](SETUP-QUESTIONS.md); example in `society.example.json`).
- **Feature parity checklist:** [FEATURES.md](FEATURES.md).
- `sites/demo` is a **fictional** demo society (made-up names and venues) used for local previews and tests.
  `sites/starter` is the blank base for real clients. Neither is copied into a client build except `starter`.
- No shared passwords in production: the first admin comes from `ADMIN_EMAIL` + a unique `ADMIN_PASSWORD`;
  the app refuses to start in production while any admin/captain uses the documented demo password.

## How to clone for a new client
1. Write the answers file (copy `society.example.json`; see SETUP-QUESTIONS.md).
2. `npm run new-society -- --config client.json --out ../client-golf`
3. `cd ../client-golf && git init && npm install && cp .env.example .env` — fill `ADMIN_PASSWORD` (new, unique) and `SESSION_SECRET`.
4. `npm start`, log in with the admin email, then Admin → Settings / Competitions to fine-tune.
5. Push to a new **private** repo and deploy (see section 6).

## 1. Quick start (local)

```bash
npm install          # needs Node ≥ 20 (better-sqlite3 v11 ships prebuilt binaries for Node 20/22)
npm run seed         # creates data/society.db with the Demo society (members and handicaps, no events)
                     # node scripts/seed.js --reset --demo   -> the fictional Flamingos demo instead
npm start            # http://localhost:3000   (PORT=3100 npm start to change)
```

### Demo logins — DEMO ONLY, never use in production

| Role    | Email                                  | Password          |
|---------|----------------------------------------|-------------------|
| Admin   | `admin@example.test`       | `flamingo-demo-1` |
| Captain | `captain@example.test`     | `flamingo-demo-1` |
| Member  | `member@example.test`      | `flamingo-demo-1` |

In the Demo seed these three logins are attached to real members as placeholders (admin = Admin,
captain = Player 1, member = Player 8) — change emails/roles in *Admin → Members*. Every other member has a
placeholder `…@members.invalid` email and **no password**, so they can't log in until an admin sets one
(*Admin → Members → Reset password*) or they apply via the join page.

## Spreadsheet import

The default Demo seed (`sites/demo/seed/`) loads members, handicaps and honour categories only — it does not
create events or results. Add events in Admin, or import them with the generic importer (`src/seed/import.js`).
A spreadsheet can be one `.xlsx` with sheets `Members`, `Courses`, `Events`, `Results`, `Honours`, or CSVs
named `members.csv`, `events.csv`, … (first row = headers; common header names such as HCP/Index, Venue,
Points are recognised).

Demo invite code for the join form: `CHANGEME`. The three Demo logins (and, with `--demo`, all 18 Flamingos
members) share the demo password above.
Re-seed at any time with `npm run seed -- --reset` (wipes the database!).
`npm run seed -- --blank` creates an empty society (baseline trophies, award types, current season) instead.

**Production safety:** with `NODE_ENV=production` the app refuses to start unless `SESSION_SECRET` is set, and
refuses to start while any admin/captain account still has the demo password. A brand-new empty database is
bootstrapped from `ADMIN_EMAIL` + `ADMIN_PASSWORD` (≥ 10 chars, not the demo password). Demo seeding is refused in
production unless `SEED_DEMO=true`.

## 2. Configuration (environment variables)

| Variable | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `NODE_ENV` | – | `production` turns on secure cookies, HSTS and the safety checks above |
| `DATABASE_PATH` | `./data/society.db` | **Put this on a persistent volume in production** (e.g. `/data/society.db`) |
| `SESSION_SECRET` | random per start in dev | **Required in production** (`openssl rand -hex 32`) |
| `SOCIETY_FEATURES` | all on (Demo seed: `-rsvp`) | Default feature switches for a fresh database / seed, e.g. `-rsvp,-awards` or `rsvp=off`. Keys: `rsvp events oom birdie fedex matchplay majors fame handicaps records honours awards rules join profile_stats` |
| `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_PASSWORD` | – | Creates the first admin when the DB has no users. Password required in production |
| `TRUST_PROXY` | – | Set `1` behind Fly/Render/Railway/nginx/Caddy so secure cookies and rate-limit IPs work |
| `SOCIETY_NAME` | The Fairway Flamingos Golf Society | Only used when creating a brand-new database; afterwards edit in *Admin → Settings* |
| `BCRYPT_ROUNDS` | `11` | bcrypt cost; tests use 4 |

`.env` in the project root is loaded automatically (see `.env.example`). Real environment variables win.

### Feature switches

Admin → Settings → **Features** turns whole modules on or off (stored as `feature_<key>` rows in the
`settings` table). A switched-off module loses its nav/menu links, hub cards and home-page widgets, its
public and admin pages return 404, and its data is left untouched — switching it back on restores everything.

> **Future: platform super-admin (placeholder).** When this becomes multi-society, a platform-level
> super-admin will control which features each society may use (per-society plan/entitlements), with
> society admins only able to toggle within what's allowed. Not built yet; today the society admin owns the switches.

## 3. What's in the box

**Public:** home (hero, next-event countdown, latest-results feed, upcoming events, standings snapshot, records,
honours, awards) · events list + detail (with RSVP list and waitlist) · players + profiles (handicap history, SVG
trend chart, stats, titles, awards) · standings (Order of Merit with movement arrows + handicap leaderboard, season
selector) · records · roll of honour · awards.

**Members:** log in, RSVP going / not going (waitlist when full, auto-promotion + in-app notice), edit profile,
change password. **Join flow:** public form → admin approves (or invite code can auto-approve if enabled).

**Captains & admins:** create/edit events, enter results, add/remove RSVPs, grant awards, courses, fun records.
**Admins only:** join requests, members & roles, seasons & points schemes, roll-of-honour entries, settings,
database backup download, recalculate-everything.

Roles: `member` < `captain` < `admin`. A disabled member's session stops working immediately. The last active admin
can't be demoted or disabled.

### Project layout
```
src/server.js, app.js, config.js, db.js, schema.sql     boot, middleware, config, SQLite + schema
src/routes/{public,auth,member,admin}.js                 HTTP routes
src/lib/handicap.js, points.js                           pure maths (unit-tested)
src/lib/engine.js                                        recomputes handicaps/points/honours from the raw results
src/lib/rsvp.js, results.js, standings.js, stats.js …    domain logic
src/views/**.ejs, public/{css,js,fonts}                  templates and assets
scripts/seed.js, backup.js                               demo seeding, online backup
test/*.test.js                                           unit + HTTP tests          e2e/*.mjs   browser e2e + screenshots
Dockerfile, fly.toml, render.yaml, railway.json, deploy/ hosting configs (see §6)
```

## 4. Handicap system (and its simplifications)

**Default: society rules** (*Admin → Settings → Handicap system*, all numbers editable). After each counting
stableford round: 33–36 pts no change; over 36 the index is cut per point over by category (cat 1 0–5: 0.1,
cat 2 6–12: 0.2, cat 3 13–21: 0.3, cat 4 22–28: 0.4); under 33 it goes up 0.2; 40+ pts costs a further 1.0;
the winner of a monthly event with 9+ players is cut 1.0; a tournament winner (Major) is cut the tournament's
`winner cut` (2) on the final round. Playing handicap = index rounded; category uses the whole-number part.
Ties for "winner" with no position entered give nobody the cut (count back needs hole-by-hole cards — enter
position 1 for the count-back winner). Matchplay winner's cut is shown on the bracket; apply it with a manual
override. The WHS-style engine below is still available as the alternative mode.

### WHS-style mode

All maths is in `src/lib/handicap.js` (pure functions) and is unit-tested (`test/handicap.test.js`, `test/engine.test.js`).

* **Score differential** = `(113 / slope) × (AGS − course rating − PCC)`, rounded to 1 dp. PCC is fixed at 0.
* **Handicap index** = from the player's most recent 20 differentials, the WHS table: 3 rounds → lowest 1 − 2.0;
  4 → lowest 1 − 1.0; 5 → lowest 1; 6 → avg lowest 2 − 1.0; 7–8 → lowest 2; 9–11 → lowest 3; 12–14 → lowest 4;
  15–16 → lowest 5; 17–18 → lowest 6; 19 → lowest 7; **20 → average of the best 8**. Capped at the *Max index* setting (54).
  Fewer than 3 rounds: the starting/declared index is kept.
* **Soft / hard cap** (optional, on by default; *Settings*): relative to the lowest index in the previous 365 days,
  any rise above +3.0 is halved and the index can never rise more than +5.0 above that low.
* **Course handicap** = `index × slope/113 + (rating − par)`, rounded. **Playing handicap** = course handicap × allowance %
  (95 % default, overridable per event), rounded. **Net** = gross − playing handicap.
* **Entering results:** give *gross*, *adjusted gross*, or *stableford points*. Stableford-only entries are converted to an
  implied adjusted gross: `par + playing handicap + 36 − points`. Gross-only entries get an estimated stableford total
  `36 + par + PH − gross` (floored at 0). Admins can also add general-play rounds (outside scorecards) and set an index manually.
* **Everything derived is rebuilt chronologically** from the raw data (`engine.recomputeAll`), so correcting or deleting an
  old result safely re-flows every later handicap, position, point total and honour.

**Deliberate simplifications versus the full World Handicap System:** no PCC calculation (fixed 0); no net-double-bogey
adjustment of hole scores (the society enters *adjusted* gross itself, or stableford); no 9-hole rounds; no exceptional
scoring reduction (ESR); no 54-holes/"initial handicap" workflow (admin sets a starting index); the 365-day low index uses
index-change dates in this app only; no per-tee-set handling beyond one tee per course record; no non-score "Acceptable
Score" validation. It is a faithful *society* approximation, not an authorised handicap — don't use it for official
competitions or CONGU/WHS affiliation.

## 5. Order of Merit, records, honours, awards

* **Points per event** = points for finishing position + participation + any bonus, × the event's multiplier (e.g. a
  "major" ×2). Ties share the better position. Position comes from the scoring basis (stableford ↑, net ↓, gross ↓) or a
  typed-in position (for matchplay / scramble / countbacks).
* **Scheme** (per season, falling back to the society default): points list for 1st, 2nd, 3rd…, participation points,
  and optional **best-N rounds** count. Edit under *Admin → Seasons & points*.
* **Records** (course records, lowest net, highest stableford, biggest winning margin, longest win / podium / attendance streaks, most wins, most rounds, lowest index ever, biggest one-round handicap cut…) are
  derived from the database; admins can add custom "fun" records.
* **Roll of honour:** event winners are filled in automatically for events attached to a trophy category; the
  Society Champion (Order of Merit) is crowned when a season is closed; historic years are entered by hand (*Admin → Roll of honour*).
* **Awards:** *Admin → Awards* — create award types (Wooden Spoon, Sandbagger of the Year, …), see suggested winners
  (Wooden Spoon = fewest Order of Merit points, Sandbagger = highest average stableford, Mr Consistency, Most Improved), and grant per season with a funny citation.

## 6. Deploying

The app is a single Node process + a single SQLite file, so it needs **one always-on instance with a persistent volume**
(not serverless, not autoscaled). Whatever you pick: set `NODE_ENV=production`, `SESSION_SECRET`, `ADMIN_EMAIL`,
`ADMIN_PASSWORD`, `TRUST_PROXY=1`, and point `DATABASE_PATH` at the volume. Health check path: `/healthz`.
First deploy starts with an empty society containing only your admin account (no demo data).

> **Honesty note:** the config files below (`Dockerfile`, `fly.toml`, `render.yaml`, `railway.json`, `deploy/*`) were
> written against each platform's current docs but **have not been deployed or built** from this sandbox (no Docker, no
> accounts). Expect to tweak names/regions. The app itself is tested via `npm start` on Node 20.

**Approximate monthly costs** — prices checked on the vendors' pricing pages on 10 Oct 2026; they change, so treat as
approximate and re-check. Excluding tax and a domain name (~£10–15/yr).

| Option | What you need | ≈ Cost / month |
|---|---|---|
| **Fly.io** (`fly.toml`) | 1 × shared-cpu-1x (256 MB $2.19, 512 MB ≈ $3.69) + 1 GB volume ($0.15) + egress ($0.02/GB); no free tier; card required | **≈ $3–4** |
| **Railway** (`railway.json`) | Hobby plan $5/mo incl. $5 usage credit; a tiny Node service + 1 GB volume (volumes $0.15/GB, RAM ~$10/GB, CPU ~$20/vCPU) normally fits inside the credit; Hobby volumes max 5 GB | **≈ $5** |
| **Render** (`render.yaml`) | Starter web service $7 (512 MB) + persistent disk $0.25/GB (1 GB). Free instances can't have disks and sleep, so they're unsuitable | **≈ $7.25** |
| **Small VPS** (`deploy/`) | DigitalOcean Basic Droplet $4 (512 MB) / $6 (1 GB); Hetzner shared 2 vCPU/4 GB ≈ €5.5–6 (their small plans were repriced in 2026 and stock varies — check live). You run updates, TLS (Caddy) and backups yourself | **≈ $4–7** |

### Fly.io
```bash
fly launch --no-deploy --copy-config        # accept fly.toml, choose app name
fly volumes create society_data --size 1 --region lhr
fly secrets set SESSION_SECRET=$(openssl rand -hex 32) ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='long-passphrase'
fly deploy
```
Keep exactly **one** machine (a volume attaches to one machine). Snapshots: `fly volumes snapshots list`.

### Railway
New project → deploy from GitHub/zip → add a **Volume** mounted at `/data` → variables: `NODE_ENV=production`,
`DATABASE_PATH=/data/society.db`, `SESSION_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `TRUST_PROXY=1` → generate a domain.

### Render
New + → Blueprint → point at the repo containing `render.yaml` → fill `ADMIN_EMAIL` / `ADMIN_PASSWORD` when prompted.
(A disk makes deploys briefly interrupt service — fine for a society site.)

### Small VPS (Ubuntu/Debian + Caddy)
```bash
sudo apt install -y nodejs npm caddy   # use Node 20+ (NodeSource or nvm) — better-sqlite3 needs a prebuilt binary or build tools
sudo useradd -r -m golf && sudo mkdir -p /opt/golf-society && sudo chown golf: /opt/golf-society
# copy the project there, then as user golf:  cd /opt/golf-society && npm ci --omit=dev
# create /opt/golf-society/.env from .env.example (NODE_ENV=production, PORT=3000, secrets…)
sudo cp deploy/golf-society.service /etc/systemd/system/ && sudo systemctl enable --now golf-society
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # edit the domain, then: sudo systemctl reload caddy
sudo cp deploy/backup.cron /etc/cron.d/golf-society-backup
```

### Postgres / Supabase alternative (not implemented)
SQLite is the right default for a society (dozens of users, one writer) and is what's built and tested. If you ever want
hosted Postgres (e.g. Supabase Free: $0, 500 MB, auto-pauses after a week of inactivity; Pro: from $25/mo, daily backups),
the path is: (1) translate `src/schema.sql` to Postgres (types/`INTEGER PRIMARY KEY` → `identity`, `datetime('now')` →
`now()`); (2) swap `better-sqlite3` for `pg`/`postgres`; (3) because better-sqlite3 is synchronous, every `db.prepare(...).get()` in
`src/lib` and `src/routes` becomes `await` — a mechanical but real rewrite of roughly 2–3k lines, plus a Postgres-backed
session store; (4) keep `engine.recomputeAll` inside one transaction. Most of the maths (`handicap.js`, `points.js`) is DB-free
and would not change. Budget a day or two of development plus test updates; only worth it if you need multi-instance hosting.

### Supabase (free Postgres) — keeps the data on Render's free plan

Render's free disk is wiped on every restart/redeploy. Set `DATABASE_URL` to a Postgres connection string and the
app keeps everything (members, results, settings, feature switches, logins) in Postgres:

- **On start** it creates its tables if missing (idempotent), loads the latest saved copy, and **seeds the Demo
  data only if Postgres is empty** — so admin edits survive restarts.
- **After every change** it saves back to Postgres within ~2 seconds (and on shutdown). The last 30 versions are kept
  in `app_snapshots`, so a bad edit can be rolled back.
- **How it's stored:** the app engine is still SQLite (in memory/on local disk, fast, synchronous); Postgres holds the
  authoritative copy as versioned snapshots (`app_snapshots.data`, a SQLite image). Sessions are inside it, so
  logins survive restarts as long as `SESSION_SECRET` stays the same.
- **No `DATABASE_URL`, or Postgres unreachable at start:** the app still starts on local SQLite (and logs a warning),
  so the site never goes down — but changes are not kept.

Setup:
1. supabase.com → New project (free) → choose a region near your Render region → set a database password.
2. Project → **Connect** (top bar) → **Session pooler** → copy the URI
   (`postgresql://postgres.<ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`) and put your password in.
   Use the *Session pooler* (IPv4); the direct `db.<ref>.supabase.co` host is IPv6-only and Render can't reach it.
3. Render → your service → **Environment** → add `DATABASE_URL` = that URI → Save → it redeploys.
   Check the log for `Loaded data from Postgres` / `Postgres persistence on`.
4. Make sure `SESSION_SECRET` is set to a fixed random value (the blueprint generates one).

Local test against a local Postgres: `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/test npm run test:pg`.

## 7. Backups

The whole society is one file. Three layers, pick at least the first two:

1. **Admin → Settings → Download database backup** (admins only) — a consistent snapshot while the app is live.
2. **`npm run backup`** → `backups/society-YYYYMMDD-HHMMSS.db` (uses SQLite's online-backup API, keeps the newest 14;
   `node scripts/backup.js /path/out.db` for a custom path). Schedule it with `deploy/backup.cron`, then copy the folder off the
   machine (rsync / rclone / object storage) — a backup on the same disk isn't a backup.
3. **Platform snapshots** — Fly volume snapshots (automatic daily snapshots; retention is configurable — check current docs; snapshots beyond the first 10 GB are billed at $0.08/GB), a VPS provider's snapshot feature, etc.

**With Supabase/Postgres:** Supabase's free plan takes daily backups (kept a short time — check the dashboard under
Database → Backups; point-in-time restore is a paid add-on). Take your own too:

- `DATABASE_URL='…' npm run backup:pg` → `backups/demo-YYYYmmdd-HHMM.dump` (a `pg_dump` of the app tables) plus
  a plain `.db` copy of the latest data. Needs the Postgres client tools (`pg_dump`). Keep copies off the machine.
- Restore a dump: `pg_restore --no-owner --clean -d "$DATABASE_URL" backups/<file>.dump`, then restart the service.
- Restore a `.db` (also from Admin → Settings → Download backup): `DATABASE_URL='…' node scripts/pg-export.js --import file.db`, then restart.
- Roll back one edit: delete the newest rows in `app_snapshots` (Supabase → Table editor), then restart.

**Restore (SQLite only):** stop the app → copy the backup over `DATABASE_PATH` → delete `society.db-wal` and `society.db-shm` → start the app.
Never copy the live `.db` file with `cp` while the app is running (use the methods above).

## 8. Admin guide — running a season

**Demo extras** (captain or admin unless noted):
* *Admin → Events → Results*: enter stableford points; OoM, positions and society handicaps update.
* *Admin → Birdies & FedEx*: per event, birdies + eagles (eagle = 2) and FedEx points — or **Fill FedEx from positions** (top 10 → 10..1).
* *Admin → Matchplay*: create a knockout, type names (or "Bye"), pick the winner + margin; winners advance automatically and the champion goes on the roll of honour.
* *Admin → Majors*: create a tournament, tick its rounds, set the winner cut and whether it applies to the index.
* *Admin → Members* (admin): achievements code, lowest ever, **subs paid** (only admins see it).
* *Admin → Settings* (admin): society name, handicap mode & numbers, Rules page text, OoM scoring (stableford best-N with count back, or position points).
* Holders ("(Holder)" on the sheets) are 2025 roll-of-honour rows; add each year's winners under *Roll of honour*.


1. **Set the scene (once):** *Settings* → society name/branding text, invite code, whether members-only mode / invite auto-approve is on,
   default handicap allowance, caps, default points scheme. *Courses* → add courses with par, rating, slope for the tee you play.
2. **Start a season:** *Seasons & points* → *Create season* (name, year, dates), optionally give it its own points scheme
   (e.g. `30, 24, 20, 17, 14, 12, 10, 8, 6, 5, 4, 3, 2, 1`, participation 5, best-N 7).
3. **Admit members:** applicants appear under *Join requests* (and on the dashboard). Set a starting index and role
   (member / captain) then **Approve**. Or add people directly under *Members*. Reset a forgotten password from the member's page.
4. **Schedule events:** *Events → New event*: title, season, course, date/time, format, scoring basis (stableford / net / gross /
   manual positions), cost, capacity, notes, whether it counts for handicaps and the Order of Merit, points multiplier,
   allowance %, and an optional trophy category for the roll of honour. Members RSVP; when full, extra RSVPs go to the waitlist and
   are promoted automatically (with a notice on their account page) when someone cancels. Captains can add/remove people by hand.
5. **After the round — enter results:** *Events → Results*. One row per player who played; enter **gross** or **stableford points**
   (optionally adjusted gross, a typed position for matchplay/scramble, bonus OoM points and a note). Blank rows are ignored.
   **Save** → positions, points, net/stableford, handicap changes, Order of Merit and honours all update at once, the event
   is marked completed and appears in the home page's latest results.
6. **Handicaps:** automatic from results (see §4). Use a member's page to **add a general-play round** or **set an index by hand**
   (logged in their history). *Recalculate everything* (Seasons page) rebuilds all derived data if you ever edit the database directly.
7. **Awards:** *Awards* → pick the season, choose an award type + winner + citation → *Give award*. Create new award types
   (name, icon, colour, optional suggestion rule) any time.
8. **Close the season:** *Seasons & points* → *Close season*. The Order of Merit winner is added to the roll of honour as
   Society Champion. You can reopen a season if you closed it too early.
9. **Historic years:** *Roll of honour* → add past winners and trophy categories by hand.

## 9. Security notes

bcrypt password hashing (cost 11) · sessions in SQLite with HttpOnly, SameSite=Lax, Secure (production) cookies and session
regeneration on login · CSRF token on every POST · helmet (CSP with no inline script, HSTS, nosniff, frame-ancestors none) ·
login rate-limit (10 / 15 min / IP) and join rate-limit · uniform "email or password not recognised" message · open-redirect-safe
`next` handling · parameterised SQL everywhere, server-side validation, EJS auto-escaping · role checks on every admin route ·
members-only mode. No email is sent by the app: there is no automated password reset — admins reset passwords. (Adding email
needs an SMTP provider and is a natural next step.)

## 10. Testing

```bash
npm test            # 56 tests: handicap maths, points, RSVP/waitlist, engine (caps, recompute, honours), HTTP permissions/CSRF/rate limit/XSS
npm run e2e         # real-browser end-to-end flow on a throwaway seeded DB (port 3199); needs Chrome/Chromium (CHROME_PATH to override)
npm run screenshots # screenshots/ at 320/390/768/1024/1440 + automated audit → screenshots/audit.json
```
The e2e script covers: join request → admin approves → login → RSVP → full event/waitlist → cancellation promotes the next person →
captain enters results → handicap update → Order of Merit & latest results → create + grant an award → close season → roll of honour → permission check.
It uses `playwright-core` with the system Chrome (no browser download). `npm run screenshots` also audits horizontal overflow, 44 px tap targets,
text size, WCAG-AA colour contrast on solid backgrounds, `<main>`/`<h1>`/`lang`, and JS errors on every page × width.

## 11. Known limitations

* No email (join notifications, password reset, event reminders) — would need an SMTP service.
* Single-instance SQLite; no horizontal scaling. Postgres port is documented, not built.
* Handicap maths is a WHS-*style* approximation (see §4), not an official handicap service.
* Hole-by-hole scoring isn't stored (stableford for gross-only entries is estimated from the total).
* Waitlist/RSVP notices are in-app only. Members can't upload photos (initial-avatars are generated).
* The remaining sub-16 px text is deliberate: ~14 px uppercase micro-labels (table headers, chips, badges, eyebrows, avatar initials). All running text is ≥ 16 px.

## Starter kit: one bespoke site per society

Everything specific to one society lives in `sites/<slug>/`:

| File | What it holds |
| --- | --- |
| `site.config.json` | name, branding text, colours (`primary`, `primary_dark`, `accent`, `highlight`, `ink`, `background`), logo, default settings, feature-flag defaults (`rsvp`, `birdie_league`, `fedex_cup`, `matchplay`, `majors`, `hall_of_fame`, `awards`), rule modules (`rules.handicap.module`: `fixed` (one admin-set handicap, played off as-is everywhere; the Demo), `society` or `whs`, with `locked: true` to stop it being switched in the app; `rules.scoring.module`: `stableford-best-n` or `position-points`), rules text and how to seed |
| `seed/` | that society's seed data (`import.json` from a spreadsheet, or a bespoke `seed.js`) |
| `logo.svg` … | assets, served at `/site/<file>` |

Choose the site with `SITE=<slug>` (default `demo`). Config values are the **defaults for a fresh database**; once running, admins change settings and flags in Admin → Settings (changes are audited). `SOCIETY_FEATURES` still overrides flags at first start.

Rule modules live in `src/rules/` (`handicap/society.js`, `handicap/whs.js`, `scoring/presets.js`); register new ones in `src/rules/index.js`.

New society:

```bash
npm run new-society -- --slug fairway-flamingos --name "The Fairway Flamingos Golf Society" \
  --import their-sheet.xlsx --set features.rsvp=false --set branding.colors.primary=#225588 --db data/fairway-flamingos.db
SITE=fairway-flamingos DATABASE_PATH=data/fairway-flamingos.db npm start
```

The spreadsheet can be one `.xlsx` with sheets `Members`, `Courses`, `Events`, `Results`, `Honours`, or CSVs named `members.csv`, `events.csv`, … (first row = headers; common header names such as HCP/Index, Venue, Points are recognised).
