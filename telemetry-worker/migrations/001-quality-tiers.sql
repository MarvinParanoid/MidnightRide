-- Adds the adaptive-quality columns to a database created before them.
-- Safe to run once; SQLite has no ADD COLUMN IF NOT EXISTS, so a second run
-- will error harmlessly with "duplicate column name".
ALTER TABLE sessions ADD COLUMN q_start TEXT;
ALTER TABLE sessions ADD COLUMN q_changes INTEGER;
