-- Rollback for 3496_discovery_w11x3_flags.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3496 DID: inserted the two capability flag rows below, FALSE.
-- WHAT THIS ROLLBACK DOES: deletes them ONLY while every one is still FALSE —
-- a TRUE row means the owner turned the capability on since 3496 was applied,
-- and deleting it would silently turn it off. It raises instead. Then it
-- deletes 3496's schema_migration_ledger row so the applier re-applies it.
-- The readers treat an absent row as OFF, so nothing breaks.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('discovery_place_cooccurrence_enabled', 'discovery_trend_post_convergence_enabled') AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3496): a flag seeded by 3496 is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags
 WHERE flag IN ('discovery_place_cooccurrence_enabled', 'discovery_trend_post_convergence_enabled') AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3496_discovery_w11x3_flags.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag IN ('discovery_place_cooccurrence_enabled', 'discovery_trend_post_convergence_enabled')) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3496 rollback): a flag is still present.';
  END IF;
END $post$;
