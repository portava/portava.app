-- ============================================================================
-- Migration 0019 — Add proposed_time to meetup_time_options
--
-- Each time-poll slot can now carry an exact time of day (HH:MM) in addition
-- to the date and coarse time-block.  Nullable for backward compatibility with
-- existing rows.
-- ============================================================================

ALTER TABLE meetup_time_options
  ADD COLUMN IF NOT EXISTS proposed_time TIME;
