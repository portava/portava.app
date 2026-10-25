-- Rollback for 3952_layover_presence_crew_expiry_flags.sql (census-layover L196: the owner's presses for deleting
-- expired layover presence rows and expired crews; lane LAYOVER, census drive batch 3, 2026-10-24).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3952 DID (one transaction, additive): seeded the feature-flag rows layover_presence_expiry_enabled and
-- layover_crew_expiry_enabled TRUE (ON CONFLICT DO NOTHING), preserving production's deletion at expiry. It created no object, read and wrote no other row, and
-- wrote no feature_flag_audit_log row. The only other row its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: deletes both flag rows (only while TRUE) and 3952's ledger row, so the runner re-applies 3952 later.
-- With the rows gone, each sweep reads its flag as absent, which DELETES at expiry exactly as TRUE does: behaviour-
-- neutral. No schema object changes. public.layover_presence and public.layover_crews are not touched.
--
-- DATA. IT REFUSES WHILE EITHER FLAG IS FALSE: the owner has extended that retention (OFF = retention extended, only by
-- explicit owner action), and deleting the row would silently resume deletion at expiry. Turn it back on deliberately
-- first (the admin toggle), then re-run.
-- IT REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR EITHER FLAG (0118's foreign key is ON DELETE CASCADE,
-- so deleting the flag row would erase who changed it and when). Export or delete those rows deliberately first, then
-- re-run. If both rows are already absent it changes nothing and clears only the ledger row: a second run is a no-op.
-- Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_on    text;
  v_audit bigint;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3952 rollback): public.feature_flags and public.schema_migration_ledger must exist.';
  END IF;

  -- Both flag rows, locked so neither can be turned off, and no audit row can be added for either, while this runs.
  PERFORM 1 FROM public.feature_flags
   WHERE flag IN ('layover_presence_expiry_enabled', 'layover_crew_expiry_enabled') FOR UPDATE;
  SELECT string_agg(flag, ', ' ORDER BY flag) INTO v_on FROM public.feature_flags
   WHERE flag IN ('layover_presence_expiry_enabled', 'layover_crew_expiry_enabled') AND enabled IS NOT TRUE;
  IF v_on IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3952): % is FALSE. The owner has extended that retention (OFF = retention extended, only by explicit owner action); deleting the row would silently resume deletion at expiry. Turn it back on deliberately first, then re-run this file. Nothing was changed.', v_on;
  END IF;

  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log
     WHERE flag IN ('layover_presence_expiry_enabled', 'layover_crew_expiry_enabled');
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3952): public.feature_flag_audit_log holds % row(s) recording who turned a layover expiry flag on or off, and when. Deleting the flag rows would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;
END $pre$;

DELETE FROM public.feature_flags
 WHERE flag IN ('layover_presence_expiry_enabled', 'layover_crew_expiry_enabled') AND enabled = TRUE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3952_layover_presence_crew_expiry_flags.sql';

COMMIT;

-- ── Postconditions — assertion-only ───────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag IN ('layover_presence_expiry_enabled', 'layover_crew_expiry_enabled')) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3952): a layover expiry flag is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3952_layover_presence_crew_expiry_flags.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3952): the ledger still records 3952 as applied.';
  END IF;
END $post$;
