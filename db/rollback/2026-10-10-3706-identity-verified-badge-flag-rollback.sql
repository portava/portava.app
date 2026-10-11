-- Rollback for 3706_identity_verified_badge_flag.sql
-- NOT applied anywhere at the time of writing.
--
-- WHAT 3706 DID: seeded identity_verified_badge_enabled FALSE. Nothing else.
-- WHAT THIS ROLLBACK DOES: removes the row ONLY while it is FALSE, and deletes
-- 3706's ledger row so the applier can re-apply it.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'identity_verified_badge_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3706): identity_verified_badge_enabled is TRUE. Turn it off deliberately first.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'identity_verified_badge_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3706_identity_verified_badge_flag.sql';

COMMIT;
