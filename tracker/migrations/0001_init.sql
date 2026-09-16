-- Migration number: 0001 	 2026-09-16
-- The tracker's store. `events` is the truth; `sessions`, `attempts` and
-- `activities` are folded from it and can be rebuilt (POST admin/rebuild).
-- Never edit an applied migration: add a new file.

CREATE TABLE events (
  id          TEXT PRIMARY KEY,           -- client UUID: a batch sent twice inserts nothing
  student     TEXT NOT NULL,              -- people.sub, from the session cookie, never the client
  app         TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  at          TEXT NOT NULL,              -- client UTC ISO 8601
  received_at TEXT NOT NULL,
  app_version TEXT,
  device      TEXT,                       -- JSON, as the batch reported it
  payload     TEXT NOT NULL               -- the event exactly as received, JSON
);
CREATE INDEX events_session ON events(session_id, at);
CREATE INDEX events_student ON events(student, at);

CREATE TABLE activities (                 -- unit / exercise / item definition snapshots
  app        TEXT NOT NULL,
  id         TEXT NOT NULL,               -- unit: <unitId>; exercise: exercise:<id>; item: <unitId>/<itemId>
  kind       TEXT NOT NULL CHECK (kind IN ('unit','exercise','item')),
  parent_id  TEXT,                        -- item -> its unit
  title      TEXT,
  definition TEXT NOT NULL,               -- JSON
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app, id)
);

CREATE TABLE sessions (
  id                 TEXT PRIMARY KEY,
  student            TEXT NOT NULL,
  app                TEXT NOT NULL,
  unit_id            TEXT NOT NULL DEFAULT '',
  exercise_id        TEXT NOT NULL DEFAULT '',
  started_at         TEXT NOT NULL,
  ended_at           TEXT,
  local_date         TEXT NOT NULL,       -- YYYY-MM-DD on the child's device
  status             TEXT NOT NULL,       -- in_progress | completed | abandoned
  item_count         INTEGER,
  answered_count     INTEGER NOT NULL DEFAULT 0,   -- recounted from attempts
  correct_first_try  INTEGER NOT NULL DEFAULT 0,   -- recounted from attempts
  correct_eventually INTEGER NOT NULL DEFAULT 0,   -- recounted from attempts
  score              REAL,                -- as the app reported at completion
  max_score          REAL,
  duration_ms        INTEGER,
  params             TEXT,                -- JSON
  app_version        TEXT,
  device             TEXT,                -- JSON
  deleted            INTEGER NOT NULL DEFAULT 0    -- a parent hid a mistaken round
);
CREATE INDEX sessions_student ON sessions(student, started_at);
CREATE INDEX sessions_unit    ON sessions(app, unit_id, student);

CREATE TABLE attempts (
  session_id        TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  student           TEXT NOT NULL,
  app               TEXT NOT NULL,
  unit_id           TEXT NOT NULL DEFAULT '',
  item_id           TEXT NOT NULL,
  presented_at      TEXT,
  resolved_at       TEXT,                 -- the last try
  tries             INTEGER NOT NULL DEFAULT 0,
  first_try_correct INTEGER,              -- NULL until a try exists
  success           INTEGER,              -- correct on any try
  final_result      TEXT,                 -- result of the last try
  response          TEXT,                 -- the last response
  score             REAL,
  max_score         REAL,
  latency_ms        INTEGER,              -- the first try
  feedback          TEXT,                 -- the last feedback shown
  tries_json        TEXT NOT NULL DEFAULT '[]',
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX attempts_item ON attempts(student, app, item_id, presented_at);

CREATE TABLE families (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE people (
  sub          TEXT PRIMARY KEY,          -- Google account id
  email        TEXT UNIQUE,
  name         TEXT,
  picture      TEXT,
  family_id    TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('parent','student')),
  display_name TEXT,
  grade        TEXT,
  hidden       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT
);
