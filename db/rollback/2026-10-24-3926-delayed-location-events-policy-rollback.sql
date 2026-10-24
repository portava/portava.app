-- RISK: restores the pre-3926 PUBLIC ALL policy; reopens cross-user location
-- exposure and client writes where grants allow them. Changes no data/retention.
BEGIN;
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
