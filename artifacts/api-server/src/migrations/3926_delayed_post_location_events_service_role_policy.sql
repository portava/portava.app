-- 3926: restrict the accidentally public service policy on delayed location events.
-- POST-CUTOVER CANONICAL FORWARD MIGRATION; independent of 3925.
-- The baseline's ALL policy has USING(true)/WITH CHECK(true) but targets PUBLIC.
-- It bypasses the separate owner SELECT policy, exposing coordinates and admitting
-- client writes wherever table grants allow them. Scope it to service_role only.
-- Preserve owner reads, service writes, all stored rows, grants and retention.
-- Safe recovery: reapply this idempotent file; it preserves private access.
-- Stop on unknown successor policies; never overwrite their rules.
-- Rollback deliberately reopens cross-user coordinate exposure and client writes:
-- db/rollback/2026-10-24-3926-delayed-location-events-policy-rollback.sql
BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.delayed_post_location_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3926): delayed_post_location_events must exist';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.delayed_post_location_events'::regclass) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3926): delayed_post_location_events RLS must be enabled';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='delayed_post_location_events') <> 2 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3926): unknown successor policy; expected exactly two policies';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='delayed_post_location_events'
    AND policyname='service role manages delayed post events' AND cmd='ALL' AND permissive='PERMISSIVE'
    AND qual='true' AND with_check='true' AND (roles=ARRAY['public']::name[] OR roles=ARRAY['service_role']::name[])) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3926): unexpected service policy shape';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='delayed_post_location_events'
    AND policyname='users read own delayed post events' AND cmd='SELECT' AND permissive='PERMISSIVE'
    AND roles=ARRAY['public']::name[] AND qual='(auth.uid() = user_id)' AND with_check IS NULL) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3926): owner SELECT policy must exist unchanged';
  END IF;
END $pre$;

ALTER POLICY "service role manages delayed post events"
  ON public.delayed_post_location_events TO service_role;

DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='delayed_post_location_events'
    AND policyname='service role manages delayed post events' AND cmd='ALL' AND permissive='PERMISSIVE'
    AND roles=ARRAY['service_role']::name[] AND qual='true' AND with_check='true') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3926): ALL policy must target service_role only';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='delayed_post_location_events'
    AND policyname='users read own delayed post events' AND cmd='SELECT' AND permissive='PERMISSIVE'
    AND roles=ARRAY['public']::name[] AND qual='(auth.uid() = user_id)' AND with_check IS NULL) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3926): owner SELECT policy changed';
  END IF;
END $post$;

COMMIT;
