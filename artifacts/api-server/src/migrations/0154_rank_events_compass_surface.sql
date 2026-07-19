-- Migration 0154: widen rank_events.surface constraint to include 'compass'
--
-- Migration 0153 defined the surface CHECK to allow only 'pulse', 'discovery',
-- and 'events'.  The Compass recommendations route now calls logCompassImpression
-- which inserts rows with surface = 'compass'.  Without this migration those
-- inserts would silently fail the constraint.
--
-- item_kind is unchanged: logCompassImpression normalises Compass-specific type
-- strings (traveler→buddy, trip→plan, postcard→post) to the existing allowed
-- set in application code, so no schema change is needed for that column.

ALTER TABLE rank_events
  DROP CONSTRAINT IF EXISTS rank_events_surface_check;

ALTER TABLE rank_events
  ADD CONSTRAINT rank_events_surface_check
    CHECK (surface IN ('pulse', 'discovery', 'events', 'compass'));
