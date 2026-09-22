-- 2998_nearby_reachable_flag.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band), telegraph lane.
--
-- ═══════════════════════════════════════
-- WHAT THIS IS FOR
-- ═══════════════════════════════════════
-- census-telegraph §31 builds §4 Nearby & Available and §30A.2's
-- ReachablePersonProjection: a server-built, bucket-only projection served by
-- GET /api/nearby/reachable. This file is the capability gate for it and
-- NOTHING ELSE. It creates no table, no column, no policy and no grant,
-- because the surface reads tables that already exist and writes nothing at
-- all.
--
-- ═══════════════════════════════════════
-- WHY A FLAG ROW AT ALL, WHEN AN ABSENT ROW IS ALREADY OFF
-- ═══════════════════════════════════════
-- `isFlagEnabled` answers false for an absent row and for an unreadable one
-- alike, so the surface is off on every database with or without this file.
-- The row exists for two reasons that are not about the default:
--
--   1. scripts/check-flag-polarity.mjs refuses a PHANTOM FLAG — one read by
--      code and created by no migration. A gate nobody can find in the schema
--      is a gate nobody can turn on deliberately, and the check is right to
--      call that a defect rather than a style.
--   2. An explicit FALSE is a decision on the record. An absent row is the
--      absence of one, and the two read identically at runtime while meaning
--      completely different things to a person deciding whether to enable it.
--
-- ═══════════════════════════════════════
-- WHAT TURNING IT ON WOULD EXPOSE, STATED BEFORE ANYONE DOES
-- ═══════════════════════════════════════
-- One authenticated GET returning, for the caller's circle members and
-- accepted trip crew ONLY:
--
--   * a proximity BUCKET (nearest rung is 5 km; the projection's precision
--     field is the literal type "bucket" and cannot hold a coordinate),
--   * an availability state the person affirmatively published
--     (user_availability.open_to_meet is DEFAULT FALSE, plus an unexpired
--     quick status, or an explicit availability_window whose audience policy
--     admits the viewer),
--   * a relationship tier and shared-context counts.
--
-- It exposes no coordinate, no distance, no ETA and no timestamp finer than a
-- freshness bucket; it takes no viewport and cannot answer "who is near this
-- point"; a person in invisible mode is absent from it entirely; and every
-- consent read fails closed, answering a retryable 503 rather than an empty
-- list when a table cannot be read.
--
-- Idempotent. ON CONFLICT DO NOTHING, so re-running it never overwrites a
-- deliberate TRUE with a FALSE — a migration that can silently switch a
-- feature off is its own kind of outage.

BEGIN;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('nearby_reachable_enabled', FALSE,
   'Telegraph §4 / §30A.2: GET /api/nearby/reachable, the server-built ReachablePersonProjection over the caller''s circle members and accepted trip crew. Proximity is a bucket (5 km narrowest rung) and never a coordinate; availability is published only where the person opted in; a person in invisible mode is absent. OFF by default. Reads answer an explicitly-disabled envelope while it is off.')
ON CONFLICT (flag) DO NOTHING;

COMMIT;
