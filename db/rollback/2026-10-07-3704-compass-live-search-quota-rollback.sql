-- Rollback for 3704_compass_live_search_quota.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Drops compass_live_search_take, compass_live_search_usage and the
-- compass_live_search_enabled flag row. REFUSES while the flag is TRUE: with
-- live search on, dropping the quota would leave the code refusing every live
-- call (the quota read fails closed) without anyone having decided to stop it.
-- Turn the flag off first, on purpose.

BEGIN;

DO $pre$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'compass_live_search_enabled' AND enabled IS TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3704): compass_live_search_enabled is TRUE. Turn it off first.';
  END IF;
END $pre$;

DROP FUNCTION IF EXISTS public.compass_live_search_take(uuid, integer);
DROP TABLE IF EXISTS public.compass_live_search_usage;
DELETE FROM public.feature_flags WHERE flag = 'compass_live_search_enabled';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.compass_live_search_usage') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3704): compass_live_search_usage still exists.';
  END IF;
END $post$;
