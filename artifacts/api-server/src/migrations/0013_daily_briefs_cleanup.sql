-- Migration: daily_briefs_cleanup
-- Adds an index on brief_date so the nightly purge scan is efficient.
-- The application-level cleanup job (dailyBriefCleanup.ts) deletes rows
-- where brief_date < NOW() - INTERVAL '60 days' every 24 hours.
-- Run manually against Supabase SQL editor.
-- Direction: up only.

CREATE INDEX IF NOT EXISTS daily_briefs_brief_date_idx ON daily_briefs (brief_date);
