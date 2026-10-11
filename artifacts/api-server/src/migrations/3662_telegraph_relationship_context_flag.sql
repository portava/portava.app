-- 3662_telegraph_relationship_context_flag.sql
-- Telegraph §30A.1 — the canonical relationship vocabulary (census-telegraph
-- T380): origins FOLLOW / MUTUAL_FOLLOW / TRIP / CREW / EVENT / BUMP / NEARBY /
-- BUDDY / PLAN / MANUAL and states REQUEST_ONLY / ACTIVE / TEMPORARY /
-- RESTRICTED / BLOCKED / EXPIRED.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION. Lane T-GRP band 3660-3664.
--
-- No table, no column, no grant. The relationship is DERIVED on read from data
-- every database already has (follows, friendships, trip crews, circles, event
-- attendance, Rent-a-Buddy bookings, meetups, accepted message requests) by
-- services/telegraph/telegraphRelationship.ts; nothing is stored. This file only
-- seeds the capability flag, FALSE: GET /api/users/:id/telegraph-relationship
-- answers feature_disabled until it is turned on.
--
-- ROLLBACK: db/rollback/2026-10-10-3662-telegraph-relationship-context-flag-rollback.sql

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $pre$;

INSERT INTO public.feature_flags (flag, enabled, description)
VALUES
  ('telegraph_relationship_context_enabled', false,
   'CAPABILITY gate for Telegraph §30A.1 relationship context: GET /api/users/:id/telegraph-relationship derives a state (REQUEST_ONLY / ACTIVE / TEMPORARY / RESTRICTED / BLOCKED / EXPIRED) and in-force origins from existing data. Nothing is stored. OFF (the seed): the route answers feature_disabled.')
ON CONFLICT (flag) DO NOTHING;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'telegraph_relationship_context_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: telegraph_relationship_context_enabled was not seeded.';
  END IF;
END $post$;

COMMIT;
