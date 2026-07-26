-- Migration: Header image privacy controls
--
-- Adds per-entity flags that let owners control whether the header/cover image
-- is shown to non-members (events, trips) or to the public (profile pictures).
--
-- Design choices:
--   • events.show_header_publicly   — default false; backfilled to true for
--     existing public events so their covers keep showing.
--   • trips.show_header_publicly    — same semantics.
--   • profiles.show_profile_picture_publicly — default true (avatars are
--     currently public; opt-out rather than opt-in keeps existing behaviour).
--
-- Fully idempotent: all statements use IF NOT EXISTS / DO NOTHING guards.

-- ── events ────────────────────────────────────────────────────────────────────

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS show_header_publicly BOOLEAN NOT NULL DEFAULT false;

-- Backfill: existing public events already expect their cover to be visible.
UPDATE events
  SET show_header_publicly = true
  WHERE visibility = 'public'
    AND show_header_publicly = false;

-- ── trips ─────────────────────────────────────────────────────────────────────

ALTER TABLE trips
  ADD COLUMN IF NOT EXISTS show_header_publicly BOOLEAN NOT NULL DEFAULT false;

-- Backfill: public trips keep their cover visible.
UPDATE trips
  SET show_header_publicly = true
  WHERE visibility = 'public'
    AND show_header_publicly = false;

-- ── profiles ──────────────────────────────────────────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS show_profile_picture_publicly BOOLEAN NOT NULL DEFAULT true;

-- No backfill needed — default true preserves existing behaviour.
