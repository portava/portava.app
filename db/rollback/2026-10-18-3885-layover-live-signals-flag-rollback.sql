-- Rollback for 3885_layover_live_signals_flag.sql (census-layover L54, L55, L81, L180, L227, L228, L281, L285, L286,
-- L287: the Layover live-signal producer; owner decision 2026-10-18; layover-165 lane B2-LIVE).
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to production (ajrurzioarfkagpuxfnb).
--
-- WHAT 3885 DID (one transaction, additive): seeded the feature-flag row layover_live_signals_enabled FALSE
-- (ON CONFLICT DO NOTHING). It created no object, read and wrote no other row, and wrote no
-- feature_flag_audit_log row (a plain INSERT does not; only toggle_feature_flag_with_audit does). The only other row
-- its apply wrote is the applier's schema_migration_ledger row.
--
-- WHAT THIS DOES: deletes the flag row (only while it is FALSE) and 3885's ledger row, so the runner re-applies 3885
-- later. With the row gone, `isFlagEnabled` reads the flag as absent, which is OFF: no live conditions are resolved and
-- every certified layover record is computed exactly as before 3885 (`liveConditions: null`). No schema object changes,
-- so PostgREST's schema cache needs no reload and none is requested. airport_fact_observations is not touched: its rows
-- belong to 2860/2982 and the crowd-report channel, not to this flag.
--
-- DATA. IT REFUSES WHILE THE FLAG IS TRUE: the owner has turned the live producer on since 3885 was applied, and
-- deleting the row would silently turn it off. Turn it off deliberately first (the admin toggle), then re-run.
-- IT REFUSES WHILE public.feature_flag_audit_log HOLDS A ROW FOR THE FLAG. The admin toggle
-- (toggle_feature_flag_with_audit) writes one each time the flag is turned on or off, and 0118's foreign key from that
-- log to feature_flags is ON DELETE CASCADE, so deleting the flag row would silently erase who changed it and when,
-- and that history exists nowhere else. Export or delete those rows deliberately first, then re-run. The flag row is
-- locked FOR UPDATE first, so no toggle can turn it on, or add an audit row for it, while this runs.
-- If the flag row is already absent it changes nothing and clears only the (already absent or orphaned) ledger row:
-- a second run is a no-op.
--
-- LOCK (measured on PGlite 0.2.17 = PostgreSQL 16.4; held until the COMMIT; scratchpad/l165-b2-live/pglite/prove3885.json):
-- ACCESS SHARE on public.feature_flags (the count), ROW SHARE on it (the row lock) and ROW EXCLUSIVE on it (the DELETE
-- of one row; the same three on its primary key); ACCESS SHARE on public.feature_flag_audit_log (the
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
    RAISE EXCEPTION 'PRECONDITION FAILED (3885 rollback): public.feature_flags and public.schema_migration_ledger must exist.';
  END IF;

  -- The flag row, locked so it cannot be turned on, and no audit row can be added for it, while this transaction runs.
  PERFORM 1 FROM public.feature_flags WHERE flag = 'layover_live_signals_enabled' FOR UPDATE;
  SELECT count(*), bool_or(enabled IS NOT FALSE) INTO v_flags, v_on
    FROM public.feature_flags WHERE flag = 'layover_live_signals_enabled';
  IF v_on THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED (3885): layover_live_signals_enabled is TRUE. The owner has turned the Layover live-signal producer on since 3885 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file. Nothing was changed.';
  END IF;

  IF v_flags = 0 THEN
    RAISE NOTICE '3885 rollback: the flag row does not exist; only the ledger row is cleared.';
    RETURN;
  END IF;

  -- The flag's audit history: deleting the flag row would cascade to it (0118's foreign key is ON DELETE CASCADE).
  IF to_regclass('public.feature_flag_audit_log') IS NOT NULL THEN
    SELECT count(*) INTO v_audit FROM public.feature_flag_audit_log WHERE flag = 'layover_live_signals_enabled';
    IF v_audit > 0 THEN
      RAISE EXCEPTION 'ROLLBACK REFUSED (3885): public.feature_flag_audit_log holds % row(s) recording who turned layover_live_signals_enabled on or off, and when. Deleting the flag row would erase them (0118''s foreign key is ON DELETE CASCADE), and that history exists nowhere else; keeping or erasing it is the owner''s decision, not a rollback''s. Export or delete those rows deliberately first, then re-run this file. Nothing was changed.', v_audit;
    END IF;
  END IF;
END $pre$;

DELETE FROM public.feature_flags WHERE flag = 'layover_live_signals_enabled' AND enabled = FALSE;
DELETE FROM public.schema_migration_ledger WHERE filename = '3885_layover_live_signals_flag.sql';

COMMIT;

-- ── Postconditions — assertion-only ───────────────────────────────────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'layover_live_signals_enabled') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3885): layover_live_signals_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger WHERE filename = '3885_layover_live_signals_flag.sql') THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3885): the ledger still records 3885 as applied.';
  END IF;
END $post$;
