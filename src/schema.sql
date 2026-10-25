PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  name TEXT NOT NULL,
  nickname TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','captain','admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  handicap_index REAL,
  home_course TEXT,
  bio TEXT,
  joined_on TEXT,
  lowest_index REAL,
  achievements TEXT,
  subs_paid INTEGER NOT NULL DEFAULT 0,
  date_of_birth TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS join_requests (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  declared_index REAL,
  home_course TEXT,
  message TEXT,
  invite_ok INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  decided_by INTEGER,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tee TEXT NOT NULL DEFAULT 'Yellow',
  par INTEGER NOT NULL,
  rating REAL NOT NULL,
  slope INTEGER NOT NULL,
  location TEXT,
  holes TEXT, -- JSON [{par,si}] x18 for hole-by-hole scoring
  UNIQUE (name, tee)
);

CREATE TABLE IF NOT EXISTS seasons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  scheme TEXT
);

CREATE TABLE IF NOT EXISTS honour_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'event' CHECK (kind IN ('event','oom','other')),
  sort INTEGER NOT NULL DEFAULT 0
);

-- multi-round competitions (Majors, the Euro...). Rounds are ordinary events linked by tournament_id.
CREATE TABLE IF NOT EXISTS tournaments (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'major' CHECK (kind IN ('major','euro','other')),
  winner_cut REAL NOT NULL DEFAULT 0,
  cut_applies INTEGER NOT NULL DEFAULT 1,
  cut_note TEXT,
  honour_category_id INTEGER REFERENCES honour_categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  season_id INTEGER NOT NULL REFERENCES seasons(id),
  title TEXT NOT NULL,
  course_id INTEGER REFERENCES courses(id),
  event_date TEXT NOT NULL,
  end_date TEXT, -- multi-day events: last day (NULL = same day as event_date)
  tee_time TEXT NOT NULL DEFAULT '09:00',
  format TEXT NOT NULL DEFAULT 'stableford',
  scoring_basis TEXT NOT NULL DEFAULT 'stableford' CHECK (scoring_basis IN ('stableford','stroke_net','stroke_gross','manual')),
  cost_pence INTEGER NOT NULL DEFAULT 0,
  capacity INTEGER,
  notes TEXT,
  highlights TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled')),
  counts_handicap INTEGER NOT NULL DEFAULT 1,
  counts_oom INTEGER NOT NULL DEFAULT 1,
  counts_birdie INTEGER NOT NULL DEFAULT 1, -- 0 = not a Birdie League event
  counts_fedex INTEGER NOT NULL DEFAULT 1, -- 0 = not a FedEx Cup event
  points_multiplier REAL NOT NULL DEFAULT 1,
  allowance_pct INTEGER NOT NULL DEFAULT 95,
  honour_category_id INTEGER REFERENCES honour_categories(id) ON DELETE SET NULL,
  tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL,
  round_no INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(event_date);
CREATE INDEX IF NOT EXISTS idx_events_season ON events(season_id);

CREATE TABLE IF NOT EXISTS rsvps (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('going','waitlist','not_going')),
  queue_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS results (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- inputs (admin/captain entered)
  gross INTEGER,
  adjusted_gross INTEGER,
  stableford_in INTEGER,
  position_in INTEGER,
  bonus INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  hcp_played REAL, -- historical import: handicap actually played off (overrides the running handicap for this result only)
  -- derived (recomputed by the handicap/points engine)
  idx_at_event REAL,
  course_handicap INTEGER,
  playing_handicap INTEGER,
  ags INTEGER,
  stableford INTEGER,
  net INTEGER,
  differential REAL,
  position INTEGER,
  points INTEGER NOT NULL DEFAULT 0,
  UNIQUE (event_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_results_user ON results(user_id);

CREATE TABLE IF NOT EXISTS extra_rounds (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  played_on TEXT NOT NULL,
  course_name TEXT NOT NULL,
  ags INTEGER NOT NULL,
  rating REAL NOT NULL,
  slope INTEGER NOT NULL,
  par INTEGER NOT NULL,
  note TEXT,
  created_by INTEGER
);

CREATE TABLE IF NOT EXISTS handicap_adjustments (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  effective_on TEXT NOT NULL,
  index_value REAL NOT NULL,
  kind TEXT NOT NULL DEFAULT 'manual' CHECK (kind IN ('initial','manual')),
  note TEXT,
  created_by INTEGER
);

CREATE TABLE IF NOT EXISTS handicap_history (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  effective_on TEXT NOT NULL,
  index_before REAL,
  index_after REAL NOT NULL,
  source TEXT NOT NULL,
  result_id INTEGER,
  extra_id INTEGER,
  differential REAL,
  label TEXT
);
CREATE INDEX IF NOT EXISTS idx_hh_user ON handicap_history(user_id, seq);

-- a past season's handicap records as published (start/end of season), kept for history; current handicaps live elsewhere
CREATE TABLE IF NOT EXISTS season_handicaps (
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rank INTEGER,
  start_index REAL,
  end_index REAL,
  playing INTEGER,
  category INTEGER,
  lowest_index REAL,
  achievements TEXT,
  PRIMARY KEY (season_id, user_id)
);

CREATE TABLE IF NOT EXISTS honours (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES honour_categories(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  partner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  detail TEXT,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
  season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto'))
);

CREATE TABLE IF NOT EXISTS award_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT 's-trophy',
  tint TEXT NOT NULL DEFAULT '#fff3b8',
  description TEXT,
  rule TEXT,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS award_grants (
  id INTEGER PRIMARY KEY,
  award_type_id INTEGER NOT NULL REFERENCES award_types(id) ON DELETE CASCADE,
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  citation TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (award_type_id, season_id, user_id)
);

CREATE TABLE IF NOT EXISTS custom_records (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  value TEXT NOT NULL,
  holder_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  holder_text TEXT,
  detail TEXT,
  icon TEXT NOT NULL DEFAULT 's-star',
  tint TEXT NOT NULL DEFAULT '#fff3b8',
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  link TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  read_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  action TEXT NOT NULL,
  detail TEXT
);

-- per-event side competitions entered by the admin: Birdie League (birdies, eagles count 2) and FedEx points
CREATE TABLE IF NOT EXISTS comp_scores (
  id INTEGER PRIMARY KEY,
  comp TEXT NOT NULL CHECK (comp IN ('birdie','fedex')),
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  value INTEGER NOT NULL DEFAULT 0,
  UNIQUE (comp, event_id, user_id)
);

-- knockout matchplay
CREATE TABLE IF NOT EXISTS mp_comps (
  id INTEGER PRIMARY KEY,
  season_id INTEGER REFERENCES seasons(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 32,
  notes TEXT,
  winner_cut REAL NOT NULL DEFAULT 1,
  honour_category_id INTEGER REFERENCES honour_categories(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS mp_matches (
  id INTEGER PRIMARY KEY,
  comp_id INTEGER NOT NULL REFERENCES mp_comps(id) ON DELETE CASCADE,
  round INTEGER NOT NULL,
  slot INTEGER NOT NULL,
  p1_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  p1_name TEXT,
  p2_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  p2_name TEXT,
  winner INTEGER CHECK (winner IN (1,2)),
  result TEXT,
  UNIQUE (comp_id, round, slot)
);

-- the field for an event: players an admin/captain added (independent of RSVPs, which a society may switch off).
-- A player is "in" an event if they're here, have a result, have a Birdie/FedEx entry, or RSVP'd going.
CREATE TABLE IF NOT EXISTS event_players (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_by INTEGER,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (event_id, user_id)
);

-- membership subs, per season per member (users.subs_paid mirrors the current season)
CREATE TABLE IF NOT EXISTS subs (
  season_id INTEGER NOT NULL REFERENCES seasons(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  paid INTEGER NOT NULL DEFAULT 0,
  paid_on TEXT,
  amount REAL,
  note TEXT,
  updated_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (season_id, user_id)
);

-- Ryder Cup history (feature `ryder`): one row per cup, its players (by team) and every match by session.
CREATE TABLE IF NOT EXISTS ryder_cups (
  id INTEGER PRIMARY KEY,
  year INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  team_a TEXT NOT NULL,
  team_b TEXT NOT NULL,
  captain_a_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  captain_b_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  score_a REAL NOT NULL,
  score_b REAL NOT NULL,
  notes TEXT
);
CREATE TABLE IF NOT EXISTS ryder_players (
  cup_id INTEGER NOT NULL REFERENCES ryder_cups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team TEXT NOT NULL CHECK (team IN ('A','B')),
  sheet_points REAL,
  PRIMARY KEY (cup_id, user_id)
);
CREATE TABLE IF NOT EXISTS ryder_matches (
  id INTEGER PRIMARY KEY,
  cup_id INTEGER NOT NULL REFERENCES ryder_cups(id) ON DELETE CASCADE,
  session_no INTEGER NOT NULL,
  session_name TEXT NOT NULL,
  match_no INTEGER NOT NULL,
  a_ids TEXT NOT NULL,
  b_ids TEXT NOT NULL,
  a_written TEXT,
  b_written TEXT,
  winner TEXT NOT NULL CHECK (winner IN ('A','B','H')),
  result TEXT
);

-- team events (e.g. Texas scrambles): standalone, never part of the OoM, stats, odds or fantasy
CREATE TABLE IF NOT EXISTS team_events (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  year INTEGER NOT NULL,
  title TEXT NOT NULL,
  course TEXT,
  event_date TEXT,          -- NULL = date TBC
  format TEXT,
  src_hash TEXT
);
CREATE TABLE IF NOT EXISTS team_results (
  id INTEGER PRIMARY KEY,
  team_event_id INTEGER NOT NULL REFERENCES team_events(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  team TEXT NOT NULL,
  players TEXT NOT NULL,    -- JSON [{name, user_id|null}]
  hcp REAL,
  score INTEGER,
  to_par INTEGER
);

-- ---- Generic competition engine (additive; Demo pages don't read these) ----
CREATE TABLE IF NOT EXISTS competition_types (
  id INTEGER PRIMARY KEY,
  society_id INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  config TEXT NOT NULL, -- JSON scoring config (lib/scoring/presets.js)
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS event_competitions (
  society_id INTEGER NOT NULL DEFAULT 1,
  event_id INTEGER NOT NULL PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  competition_type_id INTEGER NOT NULL REFERENCES competition_types(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS engine_scores (
  id INTEGER PRIMARY KEY,
  society_id INTEGER NOT NULL DEFAULT 1,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_no INTEGER,
  hcp_index REAL,
  birdies INTEGER,
  position_in INTEGER,
  holes TEXT, -- JSON array of 18 gross scores (null = no return), or NULL when only totals are known
  gross_total INTEGER,
  stableford_total INTEGER,
  net_total INTEGER,
  UNIQUE (event_id, user_id)
);
CREATE TABLE IF NOT EXISTS leagues (
  id INTEGER PRIMARY KEY,
  society_id INTEGER NOT NULL DEFAULT 1,
  season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  config TEXT NOT NULL -- JSON: { events:[ids]|null, bestN, positions, participation, bonuses }
);
CREATE TABLE IF NOT EXISTS engine_results (
  id INTEGER PRIMARY KEY,
  society_id INTEGER NOT NULL DEFAULT 1,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_no INTEGER,
  playing_handicap INTEGER,
  position INTEGER,
  points INTEGER NOT NULL DEFAULT 0,
  stableford INTEGER, net INTEGER, gross INTEGER, par_bogey INTEGER,
  detail TEXT,
  config_snapshot TEXT NOT NULL, -- the exact config used, so later rule edits never rewrite history
  computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (event_id, user_id)
);

-- Fantasy League admin entries: golfers added to the pickable pool (on top of the price list) and teams entered by an admin
CREATE TABLE IF NOT EXISTS fantasy_pool (
  id INTEGER PRIMARY KEY,
  season INTEGER NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  price REAL NOT NULL CHECK (price > 0 AND price <= 50),
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fantasy_pool_name ON fantasy_pool(season, name COLLATE NOCASE);
CREATE TABLE IF NOT EXISTS fantasy_teams (
  id INTEGER PRIMARY KEY,
  season INTEGER NOT NULL,
  manager_name TEXT NOT NULL,
  team_name TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  picks TEXT NOT NULL, -- JSON [{name, user_id, price}] as priced when entered
  captain TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fantasy_teams_name ON fantasy_teams(season, team_name COLLATE NOCASE);
