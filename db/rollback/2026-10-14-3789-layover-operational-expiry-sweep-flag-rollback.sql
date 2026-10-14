-- Rollback for 3789_layover_operational_expiry_sweep_flag.sql
-- NOT applied to any database at the time of writing.
-- Deletes the flag row ONLY while it is FALSE (a TRUE row means the owner turned
-- the expiry sweep on; deleting it would silently turn it off — this raises
-- instead), then deletes 3789's schema_migration_ledger row so the applier can
-- re-apply it. Checkpoint and presence rows already deleted by the sweep are NOT
-- restored: every reader had already hidden them, and deletion is the flag's
-- purpose.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_operational_expiry_sweep_enabled' AND enabled = TRUE) THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3789): layover_operational_expiry_sweep_enabled is TRUE. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'layover_operational_expiry_sweep_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3789_layover_operational_expiry_sweep_flag.sql';

COMMIT;

DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_operational_expiry_sweep_enabled') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3789 rollback): layover_operational_expiry_sweep_enabled is still present.';
  END IF;
END $post$;
