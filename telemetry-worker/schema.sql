-- One row per session. Nothing here identifies anyone, and nothing links two
-- sessions together — `returning` is a boolean the browser tells us about
-- itself, not a device we recognise.
CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,   -- server time, ms since epoch
  day        TEXT    NOT NULL,   -- YYYY-MM-DD, for cheap grouping
  ok         INTEGER NOT NULL,   -- a frame actually rendered
  started    INTEGER NOT NULL,   -- they pressed start rather than reading the title
  fail       TEXT,               -- 'nowebgl', 'js:...' or null
  secs       INTEGER,
  bucket     TEXT,               -- <1m | 1-5m | 5-15m | 15-30m | 30m+
  km         REAL,
  max_kmh    INTEGER,
  fps        INTEGER,
  auto_share REAL,               -- share of the ride spent on autopilot
  photo      INTEGER,            -- photo mode opens
  shots      INTEGER,            -- screenshots saved
  cams       TEXT,               -- JSON array of camera modes used
  seen       TEXT,               -- JSON counts of the rare events
  -- not `returning`: that is a reserved word in SQLite (the RETURNING clause)
  is_returning INTEGER,
  device     TEXT,               -- desktop | touch
  quality    TEXT,               -- tier the session ended on: high | mid | low
  q_start    TEXT,               -- tier it started on, before the frame rate had its say
  q_changes  INTEGER,            -- how many times it stepped
  w          INTEGER,            -- viewport, rounded to the nearest 100
  h          INTEGER,
  country    TEXT                -- from Cloudflare's edge, not from the payload
);

CREATE INDEX IF NOT EXISTS idx_sessions_ts  ON sessions(ts);
CREATE INDEX IF NOT EXISTS idx_sessions_day ON sessions(day);
