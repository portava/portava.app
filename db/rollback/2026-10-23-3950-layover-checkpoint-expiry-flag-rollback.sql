-- Rollback for 3950_layover_checkpoint_expiry_flag.sql (census-layover L159: the owner's press for deleting expired
-- layover check-ins; lane LAYOVER, census drive 2026-10-23).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3950 DID (one transaction, additive): seeded the feature-flag row layover_checkpoint_expiry_enabled FALSE
-- (ON CONFLICT DO NOTHING). It created no object, read and wrote no other row, and wrote no feature_flag_audit_log row.
-- The only other row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: deletes the flag row (only while it is FALSE) and 3950's ledger row, so the runner re-applies 3950
-- later. With the row gone, `isFlagEnabled` reads the flag as absent, which is OFF: the checkpoint phase deletes nothing.
-- No schema object changes. public.layover_checkpoints is not touched.
--
-- DATA. IT REFUSES WHILE THE FLAG IS TRUE: the owner has pressed check-in retention since 3950 was applied, and deleting
-- the row would silently turn it off. Turn it off deliberately first (the admin toggle), then re-run.
-- IT REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG (0118's foreign key is ON DELETE CASCADE, so
-- deleting the flag row would erase who changed it and when). Export or delete those rows deliberately first, then
-- re-run. If the flag row is already absent it changes nothing and clears only the ledger row: a second run is a no-op.
-- Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_flags int;
  v_on    boolean;
  v_audit bigint;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3950 rollback): public.feature_flags and public.schema_migration_ledger must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on, and no audit row can be added for it, while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_checkpoint_expiry_enabled' FOR UPDATE;
  SELECT count(*), bool_or(enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'layover_checkpoint_expiry_enabled';
  IF v_on THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3950): layover_checkpoint_expiry_enabled is TRUE. The owner has pressed check-in retention since 3950 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file. Nothing was changed.';
  END IF;

  IF v_flags = 0 THEN
    RAISE NOTICE '3950 rollback: the flag row does not exist; only the ledger row is cleared.';
    RETURN;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag = 'layover_checkpoint_expiry_enabled';
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3950): public.feature_flag_audit_log holds % row(s) recording who turned layover_checkpoint_expiry_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;
END $pre$;

DELETE FROM public.feature_flags WHERE flag = 'layover_checkpoint_expiry_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3950_layover_checkpoint_expiry_flag.sql';

COMMIT;

-- ── Postconditions — assertion-only ───────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_checkpoint_expiry_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3950): layover_checkpoint_expiry_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3950_layover_checkpoint_expiry_flag.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3950): the ledger still records 3950 as applied.';
  END IF;
END $post$;
