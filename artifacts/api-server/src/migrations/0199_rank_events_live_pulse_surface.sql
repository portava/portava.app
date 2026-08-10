-- Migration 0199: widen rank_events.surface CHECK to include 'live_pulse'
--
-- WHY
-- ---
-- Live Pulse (GET /api/pulse/live) assembles its rail by urgency, not by the
-- ranker.  Its serve rows were originally written with surface='pulse' — the
-- SAME key space the ranked /pulse writer uses, keyed by the SAME canonical
-- entity ids.  The outcome attribution lookup in routes/rankEvents.ts is
--
--   .eq("user_id").eq("item_id").eq("surface").eq("outcome","impression")
--   .order("served_at", desc).limit(1)          [ + .eq("session_id") IF sent ]
--
-- so the more recent Live Pulse serve row steals outcomes that belong to a
-- genuine ranked impression of the same entity.  The session_id filter is only
-- applied when the client actually sends one, so it cannot be the fix.
--
-- A distinct surface value is a distinct key space: the collision cannot occur
-- at all, the ranked corpus is untouched, and attribution stops depending on
-- the client remembering to send a session_id.
--
-- LINEAGE OF THIS CONSTRAINT
-- --------------------------
--   0153  created it inline and unnamed; Postgres named it
--         rank_events_surface_check.  Values: ('pulse','discovery','events')
--   0154  widened to add 'compass'
--   0197  widened to add search/nearby/story/event/trip/profile/explore
--   0199  (this file) adds 'live_pulse'.  No value is removed.
--
-- Additive only: every value 0197 permits is still permitted, so all existing
-- rows revalidate and no writer that works today starts failing.  Re-running is
-- safe — DROP ... IF EXISTS then ADD.
--
-- NOT INCLUDED ON PURPOSE
-- -----------------------
-- 'living_page' (written by routes/rankEvents.ts) and 'watch_feed' (written by
-- routes/mediaFeed.ts) are also absent from the 0197 vocabulary and are very
-- likely being rejected in production today.  Un-blocking them starts
-- persisting signal that is currently dropped, which is a product/data decision
-- with its own corpus implications — it is not a side effect of the Live Pulse
-- fix and belongs in its own migration.
--
-- TRANSACTION
-- -----------
-- BEGIN/COMMIT is a deliberate addition over 0154/0197.  ALTER TABLE ... ADD
-- CONSTRAINT revalidates every existing row; if any live row carries a surface
-- outside this list the ADD fails, and without a transaction the preceding DROP
-- would already have committed, leaving rank_events with NO surface constraint
-- at all.  Run `pnpm run check:rank-events-surfaces` first and read its
-- "observed rows by surface" section to confirm that cannot happen; keep the
-- transaction as the backstop.

BEGIN;

ALTER TABLE rank_events
  DROP CONSTRAINT IF EXISTS rank_events_surface_check;

ALTER TABLE rank_events
  ADD CONSTRAINT rank_events_surface_check
    CHECK (surface IN (
      'pulse','discovery','events','compass',
      'search','nearby','story','event','trip','profile','explore',
      'live_pulse'
    ));

COMMIT;
