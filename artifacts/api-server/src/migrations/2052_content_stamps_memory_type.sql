-- Migration 2052: extend content_stamps entity_type CHECK to include 'memory'
--
-- Task #3049 wired StampButton to memory detail screens using entityType="memory".
-- The existing CHECK constraint (added in 2049) did not include 'memory', so every
-- stamp attempt from a memory screen was rejected by the DB.  This migration
-- rebuilds the constraint with the full set of supported entity types.
--
-- Postgres does not support ALTER CONSTRAINT; drop and recreate is the standard path.

ALTER TABLE content_stamps
  DROP CONSTRAINT IF EXISTS content_stamps_entity_type_check;

ALTER TABLE content_stamps
  ADD CONSTRAINT content_stamps_entity_type_check CHECK (
    entity_type IN (
      'post', 'media', 'gem', 'event', 'trip', 'guide',
      'profile', 'buddy_profile', 'hotel', 'restaurant', 'destination',
      'memory', 'place'
    )
  );
