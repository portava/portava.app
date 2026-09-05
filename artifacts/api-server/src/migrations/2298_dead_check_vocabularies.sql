-- 2298_dead_check_vocabularies.sql
-- Two CHECK vocabularies that reject a value production code has always written.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band). Lane 2298.
--
-- Additive + idempotent. Both constraints are WIDENED, never narrowed: every
-- value the previous constraint permitted is still permitted, so all existing
-- rows revalidate and no writer that works today starts failing. DROP CONSTRAINT
-- IF EXISTS … ADD CONSTRAINT, so re-running the file is a no-op. No data is
-- written, no flag is flipped, no reader changes shape.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 1. rank_events.surface += 'wall'
-- ══════════════════════════════════════════════════════════════════════════════
-- routes/wall.ts:145 inserts rank_events rows with surface='wall'. The CHECK
-- (baseline:8755, last set by migration 0202) permits exactly fourteen values —
--   pulse | discovery | events | compass | search | nearby | story | event |
--   trip | profile | explore | live_pulse | living_page | watch_feed
-- — and 'wall' is not among them. No migration anywhere adds it. So EVERY Wall
-- impression and EVERY Wall action ever recorded has been rejected 23514 by the
-- database. The insert is fire-and-forget and the rejection handler only
-- logger.warn()s, so the loss is invisible in the product and invisible in the
-- ranking data.
--
-- WHY ADD THE VALUE RATHER THAN REUSE AN EXISTING ONE. The alternative was to
-- write Wall telemetry under a permitted surface such as 'discovery' or
-- 'pulse'. That is worse than the blackout: rank_events.surface is the
-- partition key every exposure denominator, slot-mix report and per-surface
-- ranking metric groups on (services/ranking/*, routes/adminRankingMetrics.ts,
-- src/scripts/*RankEvents*), so mislabelling Wall traffic would not merely fail
-- to record the Wall — it would corrupt the surface it borrowed, silently
-- inflating that surface's impressions with a different feed's. 'wall' is a
-- real, distinct surface; the vocabulary was simply never told about it.
--
-- SEPARATE CONSTRAINT FROM 2297. The open discovery-instrumentation branch
-- widens rank_events_OUTCOME_check (adding 'dismiss'). This migration touches
-- rank_events_SURFACE_check only. Different constraint, different name, no
-- overlap — the two apply in either order.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- 2. circle_presence.status += 'paused'
-- ══════════════════════════════════════════════════════════════════════════════
-- circle_presence_status_check (baseline:4476) permits
--   active | arrived | with_group | leaving | safe | needs_help
-- and TWO production writers write 'paused' into that column:
--   * routes/circle.ts:1846  POST /circle/pause-on-session-end — the explicit
--     "stop sharing my presence" control. The UPDATE is rejected 23514, the
--     route checks the error and returns db_error, so this endpoint has always
--     failed with a 500 and Circle sharing could never be paused by the person
--     sharing it.
--   * routes/profile.ts:1414  the deactivation path, which pauses presence
--     server-side "so their presence is hidden even if the client never calls
--     pause-on-session-end". That write is fire-and-forget
--     (`.then(undefined, () => {})`), so a deactivating user's presence has
--     silently stayed visible on other members' maps.
-- Both are privacy controls, and both have been inert since the column existed.
-- The reader that pairs with them (`.neq("status","paused")`, circle.ts:1833)
-- was already spelled correctly; it just never had a row to exclude.
--
-- ROLLBACK (returns to the pre-2298 vocabularies; only safe while no row
-- carries either new value):
--   BEGIN;
--   ALTER TABLE public.rank_events DROP CONSTRAINT IF EXISTS rank_events_surface_check;
--   ALTER TABLE public.rank_events ADD CONSTRAINT rank_events_surface_check
--     CHECK (surface = ANY (ARRAY['pulse','discovery','events','compass','search',
--       'nearby','story','event','trip','profile','explore','live_pulse',
--       'living_page','watch_feed']::text[]));
--   ALTER TABLE public.circle_presence DROP CONSTRAINT IF EXISTS circle_presence_status_check;
--   ALTER TABLE public.circle_presence ADD CONSTRAINT circle_presence_status_check
--     CHECK (status = ANY (ARRAY['active','arrived','with_group','leaving','safe','needs_help']::text[]));
--   COMMIT;
--
-- TRANSACTION. Required, same reasoning as 0199/0202/2297: ALTER TABLE … ADD
-- CONSTRAINT revalidates every existing row, and without the transaction a
-- failed ADD after a committed DROP would leave the table with NO constraint at
-- all. Each widened list is a strict superset of the one it replaces, so it
-- cannot fail on an existing row — the transaction is the backstop, not the plan.

BEGIN;

-- ── Preconditions ────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.rank_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.rank_events does not exist.';
  END IF;
  IF to_regclass('public.circle_presence') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.circle_presence does not exist.';
  END IF;
END $$;

-- ── 1. rank_events.surface ───────────────────────────────────────────────────
ALTER TABLE public.rank_events
  DROP CONSTRAINT IF EXISTS rank_events_surface_check;

ALTER TABLE public.rank_events
  ADD CONSTRAINT rank_events_surface_check
  CHECK (surface = ANY (ARRAY[
    'pulse', 'discovery', 'events', 'compass', 'search', 'nearby', 'story',
    'event', 'trip', 'profile', 'explore', 'live_pulse', 'living_page',
    'watch_feed',
    'wall'
  ]::text[]));

-- ── 2. circle_presence.status ────────────────────────────────────────────────
ALTER TABLE public.circle_presence
  DROP CONSTRAINT IF EXISTS circle_presence_status_check;

ALTER TABLE public.circle_presence
  ADD CONSTRAINT circle_presence_status_check
  CHECK (status = ANY (ARRAY[
    'active', 'arrived', 'with_group', 'leaving', 'safe', 'needs_help',
    'paused'
  ]::text[]));

-- ── Postconditions ───────────────────────────────────────────────────────────
-- Assert BOTH directions: the new value is admitted, and a value that was
-- permitted before is still permitted. A one-directional assertion would pass
-- on a constraint that had replaced the vocabulary instead of widening it.
DO $$
DECLARE def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public' AND r.relname = 'rank_events'
    AND c.conname = 'rank_events_surface_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: rank_events_surface_check is absent.';
  END IF;
  IF def NOT LIKE '%''wall''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: rank_events_surface_check does not admit ''wall'': %', def;
  END IF;
  IF def NOT LIKE '%''watch_feed''%' OR def NOT LIKE '%''pulse''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: rank_events_surface_check narrowed the existing vocabulary: %', def;
  END IF;

  SELECT pg_get_constraintdef(c.oid) INTO def
  FROM pg_constraint c
  JOIN pg_class r ON r.oid = c.conrelid
  JOIN pg_namespace n ON n.oid = r.relnamespace
  WHERE n.nspname = 'public' AND r.relname = 'circle_presence'
    AND c.conname = 'circle_presence_status_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: circle_presence_status_check is absent.';
  END IF;
  IF def NOT LIKE '%''paused''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: circle_presence_status_check does not admit ''paused'': %', def;
  END IF;
  IF def NOT LIKE '%''needs_help''%' OR def NOT LIKE '%''active''%' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: circle_presence_status_check narrowed the existing vocabulary: %', def;
  END IF;
END $$;

COMMIT;
