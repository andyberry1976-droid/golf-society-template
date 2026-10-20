# Feature parity checklist (template vs the original society site)

Status: ✅ ported & generic · ⚙️ ported, configurable per society · 🟡 ported with a limitation · ❌ not ported.
"Flag" = feature switch key (Admin → Settings → Features, `features` in site config, or `SOCIETY_FEATURES` env).

| Area | Feature | Status | Flag | Tests |
|---|---|---|---|---|
| Branding | Name, short name, hero, tagline, footer, colours (20+ CSS vars), logo, theme colour | ⚙️ | — | starter-kit |
| Branding | One config folder per society (`sites/<slug>`), validated | ⚙️ | — | starter-kit |
| Setup | `npm run new-society -- --config` non-interactive client setup | ✅ new | — | setup-society |
| Setup | Spreadsheet import of members/results (`scaffold-site --import`) | ✅ | — | society, starter-kit |
| Home | Hero, next events, notices, birthday banner, latest results | ✅ | — | http, birthdays |
| Events | List, detail, course, tee time, cost (TBC), capacity, notes, highlights | ✅ | events | http, cost-tbc |
| Events | RSVP + waitlist + promotion notices | ⚙️ | rsvp | rsvp, http |
| Events | Playing field (add/remove players, works with RSVPs off) | ✅ | events | event-players |
| Events | Excel export / edit / re-import with preview | ✅ | events | events-xlsx |
| Events | Odds for the next event (for fun) | ⚙️ | odds | odds |
| Results | Score entry (gross / stableford / position / bonus), auto positions & points | ✅ | — | engine, points |
| Results | Scores Excel export / import with preview | ✅ | — | scores-xlsx |
| Results | Results sub-menu (desktop dropdown, mobile group, footer column) | ✅ | — | menu |
| Results | All competitions overview page | ✅ | — | features |
| Order of Merit | Position points or stableford-score modes, best N, countback, multipliers, per-season schemes | ⚙️ | oom | points, engine |
| Birdie League | Per-event birdie counts, per-event "counts" switch | ⚙️ | birdie | features, society |
| FedEx Cup | Per-event points, per-event switch | ⚙️ | fedex | features |
| Majors & Euro | Multi-round tournaments, cuts, boards | ✅ | majors | society |
| Matchplay | Knockout brackets, admin edit | ✅ | matchplay | society |
| Texas Scramble | Team results page (joint places, member links, not in OoM/stats) | ⚙️ | scramble | scramble |
| Ryder Cup | History: teams, captains, sessions, player points | ⚙️ | ryder | features |
| Fantasy League | Rules page, captain/squad/budget, place points, bonuses, wooden spoon | ⚙️ rules via `fantasy_rules` setting | fantasy | fantasy |
| Fantasy League | Player prices generated from the data (live) or frozen to a file | ✅ | fantasy | fantasy |
| Fantasy League | Team picking / live fantasy leaderboard | ❌ (original is a teaser too) | fantasy | — |
| Competition engine | Competition types from presets (Stableford, medal net/gross, par/bogey, scramble, better-ball, matchplay, classic OoM) | ✅ new | engine | scoring-engine |
| Competition engine | Allowance %, team handicap weights, max net double bogey, countback, points tables, bonuses, last-place penalty | ✅ new | engine | scoring-engine |
| Competition engine | Link any event to a competition type, hole-by-hole or total scores, results stored with rule snapshot | ✅ new | engine | scoring-engine |
| Competition engine | Custom league tables (types, season, best N) + public pages | ✅ new | engine | scoring-engine |
| Competition engine | Engine results feeding the classic Order of Merit / stats | ❌ (engine leagues are separate) | — | — |
| Players | Player list, profiles, stats panel, recent results, achievements | ⚙️ | profile_stats | http, statawards |
| Handicaps | WHS-style, "society" buffer/category cuts, or fixed admin-set mode | ⚙️ | handicaps | handicap, fixed-handicap, society |
| Handicaps | Admin handicap changes with history + audit; Handicap Records page | ✅ | handicaps | fixed-handicap |
| Records | Records page, admin fun records | ✅ | records | http |
| Honours | Roll of Honour, categories, auto honours from events | ✅ | honours | http |
| Hall of Fame | Hall of Fame page | ✅ | fame | features |
| Awards | Award types & grants, stats awards ("by the numbers") | ✅ | awards | statawards |
| Birthdays | Page (day/month only), home banner, admin edit | ⚙️ | birthdays | birthdays |
| Rules | Rules page from editable rules text + handicap explanation | ⚙️ | rules | features |
| Membership | Join requests, invite code, auto-approve, admin queue | ⚙️ | join | http |
| Membership | Subs per season, Excel export, members see only their own | ⚙️ | subs | subs |
| Membership | Roles (member / captain / admin), admin-only login mode | ⚙️ | — | http, admin-login-only |
| Seasons | Season pickers up to this year + 5; picking a future year creates it | ✅ | — | future-seasons |
| Seasons | Close season → champion on roll of honour; new-season tools | ✅ | — | engine |
| Admin | Dashboard, settings, courses, members, events, seasons | ✅ | — | http |
| Admin | Audit log of admin actions | ✅ | — | event-players, subs |
| Admin | Backup download (`/admin/backup`), `npm run backup`, Postgres/Supabase snapshots | ✅ | — | pgstore |
| Admin | Handover fence (no writes while a new instance takes over) | ✅ | — | handover |
| Layout | Mobile layouts (stacked tables/cards, mobile menu) | ✅ | — | e2e/mobile.mjs |
| Security | No shared demo password in production; CSRF; rate limits; helmet | ✅ | — | http, admin-login-only |
| Society-only | Importers for the original society's past seasons / archive / WhatsApp subs list | ❌ removed (bespoke data) | — | — |
| Content | Galleries / news | n/a (not in the original; notices only) | — | — |

Demo data: `sites/demo` is fictional (made-up names, venues and branding; scores randomised from a realistic season shape).
