# New society setup questions

Answer these in a JSON file and run `npm run new-society -- --config answers.json [--out DIR] [--force]`.
Only `society_name` is required; everything else has a default. See `society.example.json`.

| Key | Question | Default | Options / format |
|---|---|---|---|
| `society_name` | What's the society's full name? | — (required) | text, e.g. "The Sunny Hackers Golf Society" |
| `short_name` | Short name for the menu, titles and messages? | name without "The" / "Golf Society" | text |
| `slug` | Folder/id for the site? | made from the name | lowercase letters, digits, dashes (max 40) |
| `hero_title` | Big title on the home page? | `society_name` | text |
| `tagline` | One-line description on the home page? | starter text | text |
| `footer_blurb` / `join_blurb` | Footer text / "Join us" text? | name / starter text | text |
| `domain` | Website domain? | none | e.g. `sunnyhackers.co.uk` (written to `.env.example` as PUBLIC_URL) |
| `admin_email` | Admin's login email? | none (set ADMIN_EMAIL later) | email |
| `admin_name` | Admin's display name? | "Society Admin" | text |
| `colors` | Brand colours? | starter green/pink | `{ "primary", "primary_dark", "accent", "highlight", "ink", "background" }` as `#rrggbb` |
| `logo` | Logo file? | none (text wordmark) | path to .png/.svg/.jpg (copied into the site folder) |
| `currency` | Currency symbol for costs and subs? | `£` | text |
| `contact_email` | Public contact email in the footer? | none | email |
| `invite_code` | Invite code for the Join page? | random | text |
| `members_only` | Hide the site from logged-out visitors? | `false` | true / false |
| `admin_only_login` | Only admins log in (members don't have accounts)? | starter default (`false`) | true / false |
| `handicap_mode` | How are handicaps worked out? | `whs` | `whs` (WHS-style from scores), `society` (buffer + category cuts), `fixed` (admin sets them) |
| `features` | Which modules are on? | all on | object of feature → true/false. Keys: rsvp, events, oom, birdie, fedex, matchplay, majors, fame, handicaps, records, honours, awards, rules, join, subs, ryder, birthdays, fantasy, scramble, odds, engine, profile_stats |
| `competition_presets` | Which competition types to start with? | stableford, medal_net, texas_scramble, better_ball, matchplay | any of: classic, stableford, medal_net, medal_gross, par_bogey, texas_scramble, better_ball, matchplay (all editable later in Admin → Competitions) |
| `season_start_year` | First season year? | this year | year; seasons are created from it to this year (past ones closed) |
| `members_csv` | Members list to import? | none | CSV/XLSX path; columns like `name,email,handicap` (see README "Spreadsheet import") |

After setup: fill `ADMIN_PASSWORD` (unique, 10+ characters; demo passwords are refused) and `SESSION_SECRET` in `.env`, then `npm start`.
Rules text, points schemes, fantasy rules (`fantasy_rules` setting, JSON: budget, squad, played, beatHandicap, beatHandicapAt, birdie, woodenSpoon, places) and everything else can be changed in the admin afterwards.
