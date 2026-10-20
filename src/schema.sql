-- Every row carries society_id so one database can later hold many societies (Postgres-friendly types).
CREATE TABLE IF NOT EXISTS settings (society_id INTEGER NOT NULL DEFAULT 1, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (society_id, key));
CREATE TABLE IF NOT EXISTS admins (id INTEGER PRIMARY KEY, society_id INTEGER NOT NULL DEFAULT 1, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS members (id INTEGER PRIMARY KEY, society_id INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, handicap_index REAL NOT NULL DEFAULT 28, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS courses (id INTEGER PRIMARY KEY, society_id INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, par INTEGER NOT NULL, rating REAL NOT NULL, slope INTEGER NOT NULL, holes TEXT); -- holes: JSON [{par,si}] x18 or NULL
CREATE TABLE IF NOT EXISTS competition_types (id INTEGER PRIMARY KEY, society_id INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, config TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, society_id INTEGER NOT NULL DEFAULT 1, title TEXT NOT NULL, event_date TEXT NOT NULL, course_id INTEGER REFERENCES courses(id), competition_type_id INTEGER NOT NULL REFERENCES competition_types(id), multiplier REAL NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'scheduled');
CREATE TABLE IF NOT EXISTS scores (id INTEGER PRIMARY KEY, society_id INTEGER NOT NULL DEFAULT 1, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  team_no INTEGER, hcp_index REAL, holes TEXT, gross_total INTEGER, stableford_total INTEGER, birdies INTEGER, position_in INTEGER, UNIQUE (event_id, member_id)); -- holes JSON, or totals only
CREATE TABLE IF NOT EXISTS results (id INTEGER PRIMARY KEY, society_id INTEGER NOT NULL DEFAULT 1, event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  team_no INTEGER, playing_handicap INTEGER, gross INTEGER, net INTEGER, stableford INTEGER, par_bogey INTEGER, position INTEGER, points INTEGER NOT NULL DEFAULT 0, detail TEXT,
  config_snapshot TEXT NOT NULL, computed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE (event_id, member_id));
CREATE TABLE IF NOT EXISTS leagues (id INTEGER PRIMARY KEY, society_id INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL, config TEXT NOT NULL); -- {types:[ids]|null, events:[ids]|null, from, to, bestN}
