-- 2051_stamp_milestones.sql
-- Tracks which stamp milestones (100 / 1,000 / 10,000) each user has crossed.
-- Inserted once by the server when the stamp count crosses the threshold.
-- One-time: rows are never deleted. The push notification is sent on insert.

CREATE TABLE IF NOT EXISTS stamp_milestones (
  user_id         uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  milestone_level integer     NOT NULL CHECK (milestone_level IN (100, 1000, 10000)),
  celebrated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, milestone_level)
);

CREATE INDEX IF NOT EXISTS stamp_milestones_user_id_idx ON stamp_milestones(user_id);
