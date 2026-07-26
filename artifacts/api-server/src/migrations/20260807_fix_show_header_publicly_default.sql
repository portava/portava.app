-- Migration: Correct show_header_publicly defaults after media_private_buckets migration
--
-- 20260806_media_private_buckets.sql added show_header_publicly with DEFAULT TRUE.
-- 20260806_header_image_privacy.sql intends DEFAULT FALSE for private/non-public entities.
-- On environments that already applied the buckets migration, non-public events and trips
-- will have incorrectly inherited TRUE from the column default.
--
-- This migration is idempotent: it corrects the default and backfills any non-public rows
-- that received TRUE from the buckets migration. It is safe to run because the
-- show_header_publicly toggle was not yet user-accessible when the buckets migration ran,
-- so no intentional user-set TRUE values exist on non-public entities.

-- ── events ────────────────────────────────────────────────────────────────────

ALTER TABLE events
  ALTER COLUMN show_header_publicly SET DEFAULT false;

-- Correct non-public events that got TRUE from the buckets migration default.
UPDATE events
  SET show_header_publicly = false
  WHERE visibility != 'public'
    AND show_header_publicly = true;

-- ── trips ─────────────────────────────────────────────────────────────────────

ALTER TABLE trips
  ALTER COLUMN show_header_publicly SET DEFAULT false;

-- Correct non-public trips that got TRUE from the buckets migration default.
UPDATE trips
  SET show_header_publicly = false
  WHERE visibility != 'public'
    AND show_header_publicly = true;
