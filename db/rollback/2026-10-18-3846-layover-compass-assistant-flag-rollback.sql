-- Rollback for 3846_layover_compass_assistant_flag.sql (census-layover L100, L102-L113, L268: the Layover Compass
-- assistant; owner decision 2026-10-18; layover-165 lane B1-C).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3846 DID (one transaction, additive): seeded the feature-flag row layover_compass_assistant_enabled FALSE
-- (ON CONFLICT DO NOTHING). It created no object, read and wrote no other row, and wrote no
-- feature_flag_audit_log row (a plain INSERT does not; only toggle_feature_flag_with_audit does). The only other row
-- its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: deletes the flag row (only while it is FALSE) and 3846's ledger row, so the runner re-applies 3846
-- later. With the row gone, `isFlagEnabled` reads the flag as absent, which is OFF: POST
-- /api/airport/sessions/:id/compass answers with the certified text and the airport facts, calls no model and reads
-- none of the assistant's tool sources — exactly as before 3846. No schema object changes, so PostgREST's schema
-- cache needs no reload and none is requested.
--
-- DATA. IT REFUSES WHILE THE FLAG IS TRUE: the owner has turned the assistant on since 3846 was applied, and
-- deleting the row would silently turn it off. Turn it off deliberately first (the admin toggle), then re-run.
-- IT REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG. The admin toggle
-- (toggle_feature_flag_with_audit) writes one each time the flag is turned on or off, and 0118's foreign key from that
-- log to feature_flags is ON DELETE CASCADE, so deleting the flag row would silently erase who changed it and when,
-- and that history exists nowhere else. Export or delete those rows deliberately first, then re-run. The flag row is
-- locked FOR UPDATE first, so no toggle can turn it on, or add an audit row for it, while this runs.
-- If the flag row is already absent it changes nothing and clears only the (already absent or orphaned) ledger row:
-- a second run is a no-op.
--
-- LOCK (measured on PGlite 0.2.17 = PostgreSQL 16.4; held until the COMMIT): ROW SHARE on public.feature_flags (the
-- row lock) then ROW EXCLUSIVE on it (the DELETE of one row); ACCESS SHARE on public.feature_flag_audit_log (the
-- count) and ROW EXCLUSIVE on it (0118's ON DELETE CASCADE path, which deletes no row: refused above when it would);
-- ROW EXCLUSIVE on public.schema_migration_ledger. No ACCESS EXCLUSIVE, SHARE or EXCLUSIVE lock anywhere: readers
-- never wait. A second run (flag row absent) takes no lock on feature_flag_audit_log. lock_timeout = 5s (the packet's
-- own setting). Run it in its own session: psql -X -v ON_ERROR_STOP=1 -f <this file>.

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
    RAISE EXCEPTION 'PRECONDITION FAILED (3846 rollback): public.feature_flags and public.schema_migration_ledger must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on, and no audit row can be added for it, while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_compass_assistant_enabled' FOR UPDATE;
  SELECT count(*), bool_or(enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'layover_compass_assistant_enabled';
  IF v_on THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3846): layover_compass_assistant_enabled is TRUE. The owner has turned the Layover Compass assistant on since 3846 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file. Nothing was changed.';
  END IF;

  IF v_flags = 0 THEN
    RAISE NOTICE '3846 rollback: the flag row does not exist; only the ledger row is cleared.';
    RETURN;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag = 'layover_compass_assistant_enabled';
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3846): public.feature_flag_audit_log holds % row(s) recording who turned layover_compass_assistant_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;
END $pre$;

DELETE FROM public.feature_flags WHERE flag = 'layover_compass_assistant_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3846_layover_compass_assistant_flag.sql';

COMMIT;

-- ── Postconditions — assertion-only ───────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_compass_assistant_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3846): layover_compass_assistant_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3846_layover_compass_assistant_flag.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3846): the ledger still records 3846 as applied.';
  END IF;
END $post$;
