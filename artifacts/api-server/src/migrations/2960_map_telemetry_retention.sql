-- 2960_map_telemetry_retention.sql
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (2100-2999 band).
-- Arrived on the Replit branch as 2266_map_telemetry_retention.sql; renumbered
-- into this repository's band. NOT yet applied to either database.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THIS IS 2202'S OWN STATED INTENT, LANDING
-- ══════════════════════════════════════════════════════════════════════════════
-- 2202_map_telemetry.sql's header says, in full:
--
--   "RETENTION. Rows carry `expires_at` (default 90 days) so this cannot become
--    indefinite behavioural history by accident. The existing retention sweeps
--    can adopt it; until one does, the column is the record of intent, and the
--    index makes the sweep cheap when it lands."
--
-- No sweep ever adopted it. `expires_at` has been a promise with nothing
-- keeping it, which is precisely the defect lib/intelRetentionScheduler's own
-- header describes for location_snapshots: a column that makes the feature look
-- correct while rows accumulate forever. 2202 already built this migration's
-- half of the bargain — map_telemetry_events_expiry_idx and
-- map_telemetry_drops_expiry_idx exist for exactly this DELETE.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- BOTH DATABASES HAVE THE TABLES — CHECKED, NOT ASSUMED
-- ══════════════════════════════════════════════════════════════════════════════
-- This migration was nearly written as CI-only. It is not, and the correction
-- is worth recording because the reason it looked CI-only was itself a live
-- production defect:
--
--   2202 carried a schema_migration_ledger row with applied_by='backfill'. A
--   2254 backfill row asserts only that the FILENAME existed on disk — never
--   that the file ran. 2202 had NOT run against production, so production had
--   no telemetry tables at all. routes/mapTelemetry.ts inserted into
--   map_telemetry_events, the insert failed, the route logged a warning and
--   STILL returned 200 with accepted:0 — every map telemetry event in
--   production was silently discarded while the client was told OK.
--   checkProductionDrift.ts already classified both tables "unapplied".
--
-- 2202 and 2222 have since been applied to production. Post-apply, the object
-- fingerprint over columns + checks + indexes + grants + function body (51
-- signatures) is byte-identical to portava-ci:
--
--   0696cb9acbd77e29e888d4e6b2a9e1fe
--
-- So map_telemetry_events and map_telemetry_drops, both carrying expires_at,
-- exist in production AND CI, and this is an ordinary migration applicable to
-- both.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- GRANTS FOLLOW 2202'S POSTURE, WHICH IS service_role AND NOTHING ELSE
-- ══════════════════════════════════════════════════════════════════════════════
-- 2202 grants INSERT, SELECT, DELETE on both tables to service_role only; anon
-- and authenticated hold nothing on either. The function is therefore SECURITY
-- DEFINER (so the sweep does not depend on the caller's rights) and EXECUTE is
-- granted to service_role only. It assumes NO client grant and must not be
-- reachable from one.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- THE FLAG SHIPS TRUE, AND THAT IS DELIBERATE
-- ══════════════════════════════════════════════════════════════════════════════
-- Every irreversible-DELETE sweep in this band ships behind a flag that is OFF,
-- and this one is ON. The polarity is not an oversight:
--
--   A COLLECTION control shipped OFF is a safe default — nothing is gathered
--   until somebody decides. A RETENTION control shipped OFF is the opposite:
--   it is a declared 90-day promise that nothing keeps, which is the exact
--   state this migration exists to end. Shipping it off would re-create the
--   defect in a new file.
--
-- It is also inert today, so TRUE costs nothing to verify: collection
-- (map_telemetry_enabled) is FALSE in both databases, both tables are empty,
-- and the function's first real pass will delete zero rows. Enabling retention
-- BEFORE collection means the promise is already being kept on the day
-- collection is switched on, rather than 90 days after somebody remembers.
--
-- ON CONFLICT DO UPDATE rather than DO NOTHING, so a database that already
-- carries the row from an earlier partial attempt converges on TRUE instead of
-- silently keeping a stale FALSE.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHAT CALLS IT
-- ══════════════════════════════════════════════════════════════════════════════
-- Nothing in this migration. The sweep function
-- (runMapTelemetryRetentionSweep, lib/intelRetentionScheduler.ts) reads the
-- flag and calls this function; REGISTERING that sweep on a scheduler tick is
-- the background-work lane's, not this file's.

BEGIN;

-- Preconditions. An absent table here means 2202 has not reached this database,
-- and creating a purge function for tables that do not exist would be a silent
-- no-op waiting to become a runtime error.
DO $$
BEGIN
  IF to_regclass('public.map_telemetry_events') IS NULL THEN
    RAISE EXCEPTION '2960 PRECONDITION FAILED: public.map_telemetry_events is absent — apply 2202_map_telemetry.sql first.';
  END IF;
  IF to_regclass('public.map_telemetry_drops') IS NULL THEN
    RAISE EXCEPTION '2960 PRECONDITION FAILED: public.map_telemetry_drops is absent — apply 2202_map_telemetry.sql first.';
  END IF;
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION '2960 PRECONDITION FAILED: public.feature_flags must exist.';
  END IF;
END $$;

-- Bounded, idempotent, and deterministic in what it considers expired:
-- clock_timestamp() rather than now(), so a long transaction cannot widen the
-- window mid-statement. Re-running deletes nothing new.
CREATE OR REPLACE FUNCTION public.purge_expired_map_telemetry()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  event_count bigint := 0;
  drop_count  bigint := 0;
BEGIN
  WITH deleted AS (
    DELETE FROM public.map_telemetry_events
    WHERE expires_at <= clock_timestamp()
    RETURNING 1
  )
  SELECT count(*) INTO event_count FROM deleted;

  WITH deleted AS (
    DELETE FROM public.map_telemetry_drops
    WHERE expires_at <= clock_timestamp()
    RETURNING 1
  )
  SELECT count(*) INTO drop_count FROM deleted;

  RETURN event_count + drop_count;
END;
$fn$;

REVOKE ALL ON FUNCTION public.purge_expired_map_telemetry() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.purge_expired_map_telemetry() FROM anon;
REVOKE ALL ON FUNCTION public.purge_expired_map_telemetry() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.purge_expired_map_telemetry() TO service_role;

COMMENT ON FUNCTION public.purge_expired_map_telemetry() IS
  'Enforces the 90-day Map telemetry retention 2202 declared. Deletes map_telemetry_events and map_telemetry_drops rows past expires_at and returns the combined count. service_role only; called by runMapTelemetryRetentionSweep behind map_telemetry_retention_enabled.';

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'map_telemetry_retention_enabled',
    TRUE,
    'Enforces the 90-day Map telemetry retention policy by purging expired event and drop-counter rows. Ships TRUE: a retention control shipped off is a promise nothing keeps.'
  )
ON CONFLICT (flag) DO UPDATE SET enabled = TRUE;

-- Postconditions. Assert what the file claims rather than trusting that each
-- statement above did what it looks like it did.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'purge_expired_map_telemetry'
  ) THEN
    RAISE EXCEPTION '2960 POSTCONDITION FAILED: purge_expired_map_telemetry() was not created';
  END IF;

  IF has_function_privilege('anon', 'public.purge_expired_map_telemetry()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.purge_expired_map_telemetry()', 'EXECUTE') THEN
    RAISE EXCEPTION '2960 POSTCONDITION FAILED: a client role can EXECUTE the purge function';
  END IF;

  IF NOT has_function_privilege('service_role', 'public.purge_expired_map_telemetry()', 'EXECUTE') THEN
    RAISE EXCEPTION '2960 POSTCONDITION FAILED: service_role cannot EXECUTE the purge function';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.feature_flags
    WHERE flag = 'map_telemetry_retention_enabled' AND enabled IS TRUE
  ) THEN
    RAISE EXCEPTION '2960 POSTCONDITION FAILED: map_telemetry_retention_enabled is not present and TRUE';
  END IF;
END $$;

COMMIT;
