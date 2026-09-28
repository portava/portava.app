-- 3470_discovery_stop_enforcement_flag.sql
-- Discovery stop conditions (census-discovery DV-82 / DC-32, §82, lane W10-O):
-- the ARMING switch for the seven decided halt values. ONE capability flag,
-- seeded OFF.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (3000-3999 band; Discovery outcomes
-- and stop conditions lane 3470-3474). APPLIED TO NO DATABASE by the lane that
-- wrote it other than the local PostgreSQL 16 harness.
--
-- Additive + idempotent. Safe to re-run. `*_enabled` ⇒ CAPABILITY convention:
-- read fail-closed via isFlagEnabled.
--
-- ── WHAT THIS GATES ─────────────────────────────────────────────────────────
-- `discovery_stop_enforcement_enabled`. `12` "Stop conditions" names seven
-- conditions and no number. The numbers were decided under the owner's
-- 2026-09-28 delegation (docs/architecture/discovery-decision-register.md,
-- D-W10-O-1 and D-W10-O-2) and live as named config values in
-- lib/discoveryStopConditions.ts:
--   event_rejection_rate        > 0.05 over >= 20 serve-log attempts
--   recommendation_logging_gap  > 0.10 over >= 20 serve-log attempts
--   creator_concentration       HHI > 0.25 over >= 100 resolved exposures
--   reports_hides               > 0.05 over >= 100 exposures
--   cache_bypass                any bypass (share > 0, >= 1 owed rank)
--   rls_leak                    any deviation from 3390's posture
--   attribution_double_count    any live double count
--   and, armed, an UNREADABLE database measurement halts too.
-- One 10-minute window for all seven.
--
--   ON:  the engine-mode resolver evaluates all seven under those values; any
--        trip resolves DISCOVERY_ENGINE_MODE to `legacy` (reason
--        `stop_condition`) until the evidence ages out of the window.
--   OFF / absent / unreadable (the seed): exactly the pre-§82 behaviour — two
--        unratified thresholds (5 % / 10 %) enforced, the other five measured
--        and reported `unruled`, never tripped.
--
-- ARMING NAMES ITS VALUES: the code arms only when this row is TRUE AND its
-- metadata.values_version equals STOP_ENFORCEMENT_VALUES_VERSION
-- ('stop-values-2026-09-28.1'), so an approval arms exactly the values it saw.
--
-- ARMING IN PRODUCTION IS PRODUCTION ACTIVATION, so this file only creates the
-- row, OFF. The approval request (exact values, consequences, recovery) is
-- register entry D-W10-O-3.
--
-- ── RUNTIME EFFECT OF SEEDING: NONE, AND THAT IS CHECKED ───────────────────
-- Seeded FALSE; the postcondition refuses a seed that finds it ON. Absent and
-- FALSE read the same, so an unapplied 3470 and an applied one behave alike.
-- Reader: lib/discoveryStopConditions.refreshStopEnforcement, called from
-- lib/discoveryStopMeasurements.refreshDiscoveryStopMeasurements (the refresh
-- the resolver runs on non-legacy resolutions only; production is legacy).
--
-- Depends on nothing but feature_flags. Turning it ON should wait for 3391
-- (the database measurements); without it four conditions read `unreadable`,
-- and armed, that halts — PDE would stay on legacy, which is safe but inert.
--
-- Rollback: db/rollback/2026-09-28-3470-discovery-stop-enforcement-flag-rollback.sql
-- (deletes the row while it is still FALSE, and this file's ledger row).

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3470): public.feature_flags does not exist.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'discovery_stop_enforcement_enabled',
    false,
    'Discovery stop conditions (census-discovery DV-82, §82): arms the seven decided halt values of 12 "Stop conditions" (register D-W10-O-1/2). ON: rejection > 5 %, logging gap > 10 %, creator HHI > 0.25 (>= 100 resolved), reports+hides > 5 % (>= 100 exposures), any cache bypass, any RLS deviation, any attribution double count, or an unreadable measurement resolves Discovery to legacy for the 10-minute window. OFF / absent / unreadable (the seed): the pre-§82 behaviour. Turning it on in production is an owner approval (D-W10-O-3).'
  )
ON CONFLICT (flag) DO NOTHING;

COMMIT;

-- ── Postconditions (separate transaction: they assert what persisted) ───────
DO $post$
DECLARE present int; on_count int;
BEGIN
  SELECT count(*) INTO present FROM public.feature_flags
    WHERE flag = 'discovery_stop_enforcement_enabled';
  IF present <> 1 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3470): expected discovery_stop_enforcement_enabled present, found %', present;
  END IF;

  SELECT count(*) INTO on_count FROM public.feature_flags
    WHERE flag = 'discovery_stop_enforcement_enabled' AND enabled = TRUE;
  IF on_count <> 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3470): discovery_stop_enforcement_enabled is ON — arming the stop conditions in production is an owner approval (register D-W10-O-3), and this must ship OFF';
  END IF;
END $post$;
