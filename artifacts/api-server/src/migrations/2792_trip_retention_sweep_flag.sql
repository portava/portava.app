-- 2792_trip_retention_sweep_flag.sql
--
-- Trips spec §5.3 / §21.3 — evidence retained per policy, raw data not
-- retained past its purpose. 2789 gave trip_activity_log a retention deadline
-- and trip_activity_log_prune(); 2791 gave trip_reservations.raw_text one and
-- trip_reservations_forget_raw_text(). Both functions are service_role's and
-- NOTHING IN THE DATABASE CALLS THEM: a documented retention nothing enforces
-- is the defect lib/intelRetentionScheduler.ts records for location_snapshots.
--
-- This seeds `trip_retention_sweep_enabled` FALSE — the gate for
-- lib/tripRetentionScheduler.ts, which calls both functions on a timer while
-- the flag is on and does nothing otherwise. Fail-closed: no row, an
-- unreadable row, or FALSE all mean no prune. Turning it on is the owner's
-- call (docs/architecture/manual-production-migration-runbook.md), after 2789
-- and 2791 are applied where the flag is read — the precondition below is the
-- same requirement stated at apply time.
--
-- Additive: one INSERT ... ON CONFLICT DO NOTHING.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
  IF to_regprocedure('public.trip_activity_log_prune()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_activity_log_prune() (2789) does not exist — the sweep this flag gates would have nothing to call.';
  END IF;
  IF to_regprocedure('public.trip_reservations_forget_raw_text()') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: trip_reservations_forget_raw_text() (2791) does not exist — the sweep this flag gates would have nothing to call.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('trip_retention_sweep_enabled', false,
   'Trips §5.3/§21.3: the server''s retention sweep (lib/tripRetentionScheduler.ts) calls trip_activity_log_prune() and trip_reservations_forget_raw_text() on a timer while this is on. Seeded FALSE by 2792; nothing is pruned or forgotten until it is on. Irreversible deletion of evidence past its policy — the owner turns it on.')
ON CONFLICT (flag) DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.feature_flags WHERE flag = 'trip_retention_sweep_enabled') THEN
    RAISE EXCEPTION '2792: trip_retention_sweep_enabled was not seeded';
  END IF;
END $$;

COMMIT;
