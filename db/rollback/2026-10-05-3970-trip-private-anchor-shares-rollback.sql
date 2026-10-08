-- Rollback for 3970_trip_private_anchor_shares.sql (census-trips TR256, lane C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) or travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Refuses while the sharing flag is TRUE (the owner turned sharing on; dropping
-- the table under it would silently revoke every grant) and while any grant row
-- exists (a grant is a person's own choice; removing it is not a rollback of
-- this file — revoke them through the API first, or decide deliberately).
-- Then drops the table, the flag row and 3970's ledger row.
--
-- After this rollback every private anchor is owner-only, which is the reader's
-- behaviour with the table absent: 42P01 is read as zero grants.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_private_anchor_sharing_enabled' AND enabled) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3970): trip_private_anchor_sharing_enabled is TRUE. Turn it off deliberately first.';
  END IF;
  IF to_regclass('public.trip_private_anchor_shares') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.trip_private_anchor_shares) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3970): trip_private_anchor_shares holds grants. Revoke them first, or decide deliberately to drop them.';
  END IF;
END $$;

DROP TABLE IF EXISTS public.trip_private_anchor_shares;

DELETE FROM public.feature_flags WHERE flag = 'trip_private_anchor_sharing_enabled' AND enabled = FALSE;

DELETE FROM public.schema_migration_ledger WHERE filename = '3970_trip_private_anchor_shares.sql';

COMMIT;

DO $post$
BEGIN
  IF to_regclass('public.trip_private_anchor_shares') IS NOT NULL THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3970 rollback): the table is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_private_anchor_sharing_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3970 rollback): the flag row is still present.';
  END IF;
END $post$;
