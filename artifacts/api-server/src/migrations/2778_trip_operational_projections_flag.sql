-- 2778_trip_operational_projections_flag.sql
-- Seeds `trip_operational_projections_enabled` FALSE — the capability gate for
-- the Trips read projections that need kernel-era schema: §7.3 freedom windows
-- (trip_commitments, 2761), §17.1 health (trip_risks, 2762), §11.1 today
-- (trip_stages, 2760), all on trips.version (2420).
--
-- WHY. check:flag-schema-prerequisites found the flag-TRUE / schema-ABSENT
-- class the first time these projections were wired: COMPASS_ENABLED is ON in
-- production and Compass's get_freedom_windows reached trip_commitments, which
-- production lacks. The projections now consult THIS flag first
-- (lib/tripOperationalProjections.ts), registered as a capability, so the
-- schema they need belongs to a flag that is OFF everywhere until an owner
-- turns it on after 2420 -> 2760 -> 2762 are applied.
--
-- Additive: one INSERT ... ON CONFLICT DO NOTHING. Nothing else changes.
BEGIN;

DO $$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.feature_flags (0037) does not exist.';
  END IF;
  -- NOTE, not a failure: the projections need 2420/2760-2762. Absent here means
  -- "seed the flag, never flip it on this database until they land".
  IF to_regclass('public.trip_commitments') IS NULL OR to_regclass('public.trip_risks') IS NULL OR to_regclass('public.trip_stages') IS NULL THEN
    RAISE NOTICE '2778: trip_commitments / trip_risks / trip_stages are not all present on this database (2760-2762 unapplied). trip_operational_projections_enabled is seeded FALSE and MUST stay FALSE here until 2420 -> 2760 -> 2761 -> 2762 are applied; ON would 42P01 every freedom-window, health and today read.';
  END IF;
END $$;

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  ('trip_operational_projections_enabled', false,
   'Trips read projections that need kernel-era schema: GET /trips/:id/freedom-windows (§7.3, trip_commitments), /health (§17.1, trip_risks), /today (§11.1, trip_stages), and Compass''s get_freedom_windows / get_today_state. REQUIRES 2420 (trips.version), 2760, 2761, 2762. Read fail-closed by lib/tripOperationalProjections.ts, which also probes the schema before every use and refuses with the migrations named. FALSE / absent / unreadable (the seed): the routes answer feature_disabled and Compass answers "not enabled". Enabling is an owner decision; on production only after those migrations.')
ON CONFLICT (flag) DO NOTHING;

COMMIT;
