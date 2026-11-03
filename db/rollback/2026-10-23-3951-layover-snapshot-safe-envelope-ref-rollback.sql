-- Rollback for 3951_layover_snapshot_safe_envelope_ref.sql (census-layover L25: the snapshot's safe_envelope_ref; lane
-- LAYOVER, census drive 2026-10-23, batch 2).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3951 DID (one transaction, additive): added the nullable column
-- public.layover_certified_computations.safe_envelope_ref TEXT with the CHECK layover_certcomp_safe_envelope_ref_shape,
-- commented it, and seeded the feature-flag row layover_snapshot_envelope_ref_enabled FALSE (ON CONFLICT DO NOTHING).
-- It rewrote no row and wrote no feature_flag_audit_log row. The only other row its apply wrote is the applier's
-- schema_migration_ledger row.
--
-- WHAT THIS DOES: deletes the flag row (only while it is FALSE), drops the CHECK and the column, and deletes 3951's
-- ledger row so the runner re-applies 3951 later. The flag goes FIRST, in the same transaction: with the row gone,
-- `isFlagEnabled` reads it as absent (OFF) and persistDecision stops sending the column before the column is gone.
--
-- DATA. IT REFUSES WHILE THE FLAG IS TRUE (the owner pressed it; deleting the row would silently turn it off), WHILE ANY
-- ROW HOLDS A NON-NULL safe_envelope_ref (dropping the column would erase which envelope each of those snapshots
-- published, and 3896 makes the table immutable precisely so that is never rewritten), and WHILE
-- public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG (0118's ON DELETE CASCADE would erase that history). Each
-- refusal names what to do first. If everything is already absent it changes nothing but the ledger row: a second run
-- is a no-op. Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, pg_temp;

DO $pre$
DECLARE
  v_on    boolean;
  v_refs  bigint;
  v_audit bigint;
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.schema_migration_ledger') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3951 rollback): public.feature_flags and public.schema_migration_ledger must exist.';
  END IF;

  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_snapshot_envelope_ref_enabled' FOR UPDATE;
  SELECT bool_or(enabled IS NOT FALSE) INTO v_on FROM public.feature_flags WHERE flag = 'layover_snapshot_envelope_ref_enabled';
  IF v_on THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3951): layover_snapshot_envelope_ref_enabled is TRUE. Turn it off deliberately first, then re-run this file. Nothing was changed.';
  END IF;

  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag = 'layover_snapshot_envelope_ref_enabled';
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3951): public.feature_flag_audit_log holds % row(s) recording who changed layover_snapshot_envelope_ref_enabled and when; deleting the flag row would erase them (0118''s ON DELETE CASCADE). Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;

  IF to_regclass('public.layover_certified_computations') IS NOT NULL
     AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'layover_certified_computations' AND column_name = 'safe_envelope_ref') THEN
    EXECUTE 'SELECT count(*) FROM public.layover_certified_computations WHERE safe_envelope_ref IS NOT NULL' INTO v_refs;
    IF v_refs > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3951): % stored snapshot(s) record which safe envelope they published; dropping the column would erase that from rows 3896 keeps immutable. Export them (snapshot_id, safe_envelope_ref) deliberately first, then re-run this file. Nothing was changed.', v_refs;
    END IF;
  END IF;
END $pre$;

DELETE FROM public.feature_flags WHERE flag = 'layover_snapshot_envelope_ref_enabled' AND enabled = FALSE;

DO $drop$
BEGIN
  IF to_regclass('public.layover_certified_computations') IS NOT NULL THEN
    ALTER TABLE public.layover_certified_computations DROP CONSTRAINT IF EXISTS layover_certcomp_safe_envelope_ref_shape;
    ALTER TABLE public.layover_certified_computations DROP COLUMN IF EXISTS safe_envelope_ref;
  END IF;
END $drop$;

DELETE FROM public.schema_migration_ledger WHERE filename = '3951_layover_snapshot_safe_envelope_ref.sql';

COMMIT;

-- ── Postconditions — assertion-only ───────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_snapshot_envelope_ref_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3951): layover_snapshot_envelope_ref_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'layover_certified_computations' AND column_name = 'safe_envelope_ref') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3951): layover_certified_computations.safe_envelope_ref is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3951_layover_snapshot_safe_envelope_ref.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3951): the ledger still records 3951 as applied.';
  END IF;
END $post$;
