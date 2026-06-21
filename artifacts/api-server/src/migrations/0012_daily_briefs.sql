-- Migration: daily_briefs
-- Stores one generated brief per user per trip per calendar day.
-- Provides durable once-per-day caching across server restarts.
-- Run manually against Supabase SQL editor.
-- Direction: up only.

CREATE TABLE IF NOT EXISTS daily_briefs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  trip_id      uuid        NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  brief_date   date        NOT NULL,
  brief_type   text        NOT NULL DEFAULT 'general',
  brief_json   text        NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT daily_briefs_user_date_uniq UNIQUE (user_id, brief_date)
);

CREATE INDEX IF NOT EXISTS daily_briefs_user_id_idx ON daily_briefs (user_id);
CREATE INDEX IF NOT EXISTS daily_briefs_trip_id_idx ON daily_briefs (trip_id);

-- Row-Level Security: users can only read their own briefs.
ALTER TABLE daily_briefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "daily_briefs_select_own" ON daily_briefs
  FOR SELECT USING (auth.uid() = user_id);

-- Service role bypasses RLS for all writes.
