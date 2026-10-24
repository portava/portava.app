-- MANUAL SECURITY-REGRESSING REVERSAL ONLY. Preferred safe recovery: reapply
-- 3926_delayed_post_location_events_service_role_policy.sql; it keeps data private.
-- Requires explicit owner approval; never run automatically after an error.
-- RISK: restores the pre-3926 PUBLIC ALL policy; reopens cross-user location
-- exposure and client writes where grants allow them. Changes no data/retention.
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
  ON public.delayed_post_location_events TO public;
DO $post$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='delayed_post_location_events'
    AND policyname='service role manages delayed post events' AND roles=ARRAY['public']::name[]
    AND cmd='ALL' AND qual='true' AND with_check='true') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3926): PUBLIC ALL policy not restored';
  END IF;
END $post$;
COMMIT;
