-- Rollback for 3395_discovery_dwell_telemetry_flag.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 3395 DID
-- =============
--   * INSERT ONE ROW into public.feature_flags:
--       ('discovery_dwell_telemetry_enabled', false, '<description>')
--     ON CONFLICT DO NOTHING. No table, no column, no type, no function.
--   * The applier recorded it in public.schema_migration_ledger.
--
-- WHAT THIS ROLLBACK DOES
-- =======================
-- Deletes that row, and ONLY while it is still FALSE. If it reads TRUE the
-- owner has turned dwell collection on since 3395 was applied; deleting the row
-- would silently turn it off again (an absent row reads false) with no record
-- that the owner's decision was reversed. It raises instead and the operator
-- decides.
--
-- It does NOT delete any rank_events attention row (event_type 'place_dwell').
-- While the flag was FALSE none can exist; if it was ever TRUE those rows are
-- measurements that exist nowhere else, and removing them is a retention
-- decision (`04` §11), not a rollback of this file.
--
-- It then deletes 3395's schema_migration_ledger row, so a later run of
-- scripts/src/apply-migrations.ts re-applies 3395. It changes no other row.

BEGIN;

DO $$
DECLARE on_count int;
BEGIN
  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_dwell_telemetry_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION
      'ROLLBACK REFUSED (3395): discovery_dwell_telemetry_enabled is TRUE. The owner has turned dwell collection on since 3395 was applied; deleting the row would silently turn it off. Turn it off deliberately first, then re-run this file.';
  END IF;
END $$;

-- Only the row 3395 wrote (W10-F, census-discovery §87). 3395 inserts ON
-- CONFLICT (flag) DO NOTHING, so a row that existed before it kept its own
-- description. A row whose description is not 3395's seed text byte for
-- byte (the md5 below) was not written by 3395, and is kept.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_dwell_telemetry_enabled' AND md5(coalesce(description, '')) <> 'c46353695ffd582b9fea71fc4bceac02') THEN
    RAISE NOTICE '3395 rollback: discovery_dwell_telemetry_enabled was not written by 3395 (its description is not 3395''s seed), so it is kept.';
  ELSE
    DELETE FROM public.feature_flags
      WHERE flag = 'discovery_dwell_telemetry_enabled' AND enabled = FALSE;
  END IF;
END $$;

DELETE FROM public.schema_migration_ledger
  WHERE filename = '3395_discovery_dwell_telemetry_flag.sql';

COMMIT;

-- ── Postconditions: the row is gone, and so is the ledger row ───────────────
DO $post$
BEGIN
  IF EXISTS (SELECT 1 FROM public.feature_flags
              WHERE flag = 'discovery_dwell_telemetry_enabled'
                AND md5(coalesce(description, '')) = 'c46353695ffd582b9fea71fc4bceac02') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3395 rollback): discovery_dwell_telemetry_enabled is still present.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migration_ledger
              WHERE filename = '3395_discovery_dwell_telemetry_flag.sql') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3395 rollback): the ledger still records 3395 as applied.';
  END IF;
END $post$;
