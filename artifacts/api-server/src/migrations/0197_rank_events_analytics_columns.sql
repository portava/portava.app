-- Migration 0155: add analytics-event columns to rank_events
--
-- The ranking pipeline emits fire-and-forget analytics events (e.g.
-- ranking_item_eligible, ranking_item_scored, ranking_activity_boost_applied)
-- as rows in rank_events alongside the existing impression / outcome rows.
--
-- Analytics rows differ from impression rows in three ways:
--   1. outcome = 'analytics'  (new allowed value — prevents the impression-
--      finding query from accidentally matching analytics rows)
--   2. event_type is set      (e.g. 'ranking_item_eligible')
--   3. content_type is set    (mirrors item_kind but nullable for flexibility)
--   4. item_kind and position may be NULL (analytics rows have no list position)
--
-- All changes are backward-compatible: existing impression / outcome rows are
-- unchanged, their NOT NULL values remain, and the widened CHECK still accepts
-- every old value.

-- 1. Widen outcome CHECK to allow the new server-side 'analytics' sentinel.
--    Clients never send this value; it is set only by the ranking pipeline.
ALTER TABLE rank_events
  DROP CONSTRAINT IF EXISTS rank_events_outcome_check;

ALTER TABLE rank_events
  ADD CONSTRAINT rank_events_outcome_check
    CHECK (outcome IN ('impression','tap','save','join','rsvp','attended','analytics'));

-- 2. Add event_type — the canonical analytics event name (e.g. 'ranking_item_eligible').
--    NULL for legacy impression/outcome rows (backward-compatible).
ALTER TABLE rank_events
  ADD COLUMN IF NOT EXISTS event_type text;

-- 3. Add content_type — the content kind as reported by the ranking pipeline
--    (e.g. 'post', 'event', 'buddy').  Mirrors item_kind but nullable.
ALTER TABLE rank_events
  ADD COLUMN IF NOT EXISTS content_type text;

-- 4. Make item_kind nullable so analytics rows can omit it.
--    Existing impression rows always have a value; the CHECK still validates
--    non-NULL values (NULL passes Postgres CHECK by default).
ALTER TABLE rank_events
  ALTER COLUMN item_kind DROP NOT NULL;

-- 5. Make position nullable for the same reason.
--    Analytics rows have no 0-indexed position in a served list.
ALTER TABLE rank_events
  ALTER COLUMN position DROP NOT NULL;

-- 6. Widen surface CHECK to include all SurfaceName values used by the
--    ranking pipeline (search, nearby, story, event, trip, profile, explore).
--    Migration 0154 widened the original 0153 set to add 'compass'; this
--    migration adds the remaining ranking surfaces.
ALTER TABLE rank_events
  DROP CONSTRAINT IF EXISTS rank_events_surface_check;

ALTER TABLE rank_events
  ADD CONSTRAINT rank_events_surface_check
    CHECK (surface IN (
      'pulse','discovery','events','compass',
      'search','nearby','story','event','trip','profile','explore'
    ));

-- Index for analytics event queries (event_type lookups).
CREATE INDEX IF NOT EXISTS rank_events_event_type
  ON rank_events (event_type)
  WHERE event_type IS NOT NULL;
