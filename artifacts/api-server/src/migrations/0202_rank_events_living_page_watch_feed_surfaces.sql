-- Migration 0202: widen rank_events.surface CHECK to include 'living_page' and 'watch_feed'
--
-- WHY
-- ---
-- Both values are ALREADY being written by production code and are ALREADY being
-- rejected by the CHECK, silently:
--
--   living_page  — routes/rankEvents.ts (Living Page path), line 66
--   watch_feed   — routes/mediaFeed.ts, six call sites (serve rows, ranking
--                  snapshots, and the outcome-attribution reads that filter
--                  .eq("surface","watch_feed"))
--
-- The Living Page write is fire-and-forget by design, so its rejection surfaces
-- nowhere but a warn log. `check:rank-events-surfaces` has been reporting this
-- on every single run as a standing informational FINDING:
--
--   Written by the code but ZERO rows present: discovery, living_page, live_pulse
--
-- and the live corpus confirms it — `SELECT surface, count(*) FROM rank_events`
-- returns only pulse / compass / events. Every living_page and watch_feed
-- impression the app has ever tried to record has been dropped on the floor.
--
-- 0199 deliberately excluded these two, on the grounds that admitting them
-- starts persisting signal that is currently discarded and that this is a
-- product/data decision rather than a side effect of the Live Pulse fix. That
-- decision has now been taken explicitly: continuing to lose the signal is worse
-- than recording it. This migration is that decision, made in its own file.
--
-- WHAT THIS DOES NOT DO
-- ---------------------
-- It does not rewrite 0199. 0199 is applied and released; its history stands.
-- The chain reads: 0197 widened to 11 values, 0199 added 'live_pulse' (12), 0202
-- adds 'living_page' and 'watch_feed' (14). Each step is additive and each is
-- legible on its own.
--
-- ADDITIVE — NOTHING IS REMOVED
-- -----------------------------
-- All 12 values permitted by 0199 remain permitted. Verified before applying:
-- live rank_events holds only 'pulse' (185,293), 'compass' (12,748) and
-- 'events' (5,200), every one of which is inside the list below, so the
-- revalidating ADD cannot fail on an existing row.
--
-- TRANSACTION
-- -----------
-- Same reasoning as 0199, and it is not optional. ALTER TABLE ... ADD CONSTRAINT
-- revalidates every existing row; without the transaction a failed ADD after a
-- committed DROP would leave rank_events with NO surface constraint at all —
-- the half-applied state that `check:rank-events-surfaces` treats as a
-- fail-closed BLOCK.
--
-- VERIFY (behaviourally, not by reading the CHECK)
-- ------------------------------------------------
--   pnpm run check:rank-events-surfaces
-- REQUIRED_SURFACES now contains live_pulse, living_page and watch_feed, so the
-- gate attempts a real INSERT for each and prints one GATE line per surface.
-- Proceed only on exit 0 with all three reading PERMITTED.
--
-- ROLLBACK (returns to the 0199 vocabulary):
--   BEGIN;
--   ALTER TABLE rank_events DROP CONSTRAINT IF EXISTS rank_events_surface_check;
--   ALTER TABLE rank_events ADD CONSTRAINT rank_events_surface_check
--     CHECK (surface IN ('pulse','discovery','events','compass','search','nearby',
--                        'story','event','trip','profile','explore','live_pulse'));
--   COMMIT;
-- Note the rollback will FAIL if any living_page or watch_feed row has landed by
-- then — which is the point of admitting them.

BEGIN;

ALTER TABLE rank_events
  DROP CONSTRAINT IF EXISTS rank_events_surface_check;

ALTER TABLE rank_events
  ADD CONSTRAINT rank_events_surface_check
    CHECK (surface IN (
      'pulse','discovery','events','compass',
      'search','nearby','story','event','trip','profile','explore',
      'live_pulse',
      'living_page','watch_feed'
    ));

COMMIT;
