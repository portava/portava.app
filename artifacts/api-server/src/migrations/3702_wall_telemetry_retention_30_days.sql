-- 3702_wall_telemetry_retention_30_days.sql
-- Wall telemetry is kept 30 days, not 90 (owner ruling Q11(a), 2026-10-04), and
-- this time something deletes it.
--
-- POST-CUTOVER CANONICAL FORWARD MIGRATION (lane L band 3700-3719). APPLIED TO
-- NO DATABASE by the lane that wrote it. Sequenced by the integration owner.
--
-- ══════════════════════════════════════════════════════════════════════════════
-- WHY
-- ══════════════════════════════════════════════════════════════════════════════
-- 2308_wall_telemetry_events.sql gives every row
--
--     viewer_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
--     expires_at timestamptz NOT NULL DEFAULT (now() + interval '90 days')
--
-- so each row is a raw behavioural event tied to a person, kept 90 days on
-- paper — and NOTHING deletes a row past expires_at: no purge function, no
-- sweep, no pg_cron (census-wall §23.3, census-map §51.2). The owner's ruling
-- (docs/ops/owner-decisions-20261004.md):
--
--   "Set Q11(a) raw behavioural-row retention to 30 days, then delete the
--    identifiable raw rows; retain only irreversibly aggregated data where
--    needed. Treat 30 days as the proposed product default pending the
--    required legal review."
--
-- This file sets the DEFAULT to 30 days and shortens any row already stamped
-- later (never lengthens one) — the same shape as 3701 for Map telemetry. The
-- DELETE is lib/wallTelemetryRetention.ts runWallTelemetryRetentionSweep, on
-- the intel retention scheduler's timer. It needs no function here: 2308 grants
-- service_role DELETE on the table and the expiry index
-- (wall_telemetry_events_expiry_idx) exists for exactly that delete.
--
-- NO FLAG, as 3701 has none: a retention control shipped switched off is a
-- declared promise that nothing keeps (2960's header and
-- runInputOutcomeRetentionSweep's say so at length). Collection itself stays
-- behind wall_enabled.
--
-- Rollback: db/rollback/2026-10-06-3702-wall-telemetry-retention-30-days-rollback.sql
-- (restores the 90-day DEFAULT; lengthens no row).

BEGIN;

DO $pre$
BEGIN
  IF to_regclass('public.wall_telemetry_events') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3702): public.wall_telemetry_events does not exist; 2308 must be applied first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'wall_telemetry_events' AND column_name = 'expires_at')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'wall_telemetry_events' AND column_name = 'occurred_at') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3702): public.wall_telemetry_events lacks expires_at or occurred_at.';
  END IF;
  -- The sweep deletes as service_role; 2308 grants it. Without it the sweep
  -- would fail every tick and the 30 days would be a promise again.
  IF NOT has_table_privilege('service_role', 'public.wall_telemetry_events', 'DELETE') THEN
    RAISE EXCEPTION 'PRECONDITION FAILED (3702): service_role cannot DELETE from wall_telemetry_events; the retention sweep could not run.';
  END IF;
END $pre$;

ALTER TABLE public.wall_telemetry_events ALTER COLUMN expires_at SET DEFAULT (now() + interval '30 days');

-- Shorten, never lengthen: a row whose expiry is already sooner keeps it.
UPDATE public.wall_telemetry_events SET expires_at = occurred_at + interval '30 days'
 WHERE expires_at > occurred_at + interval '30 days';

COMMENT ON COLUMN public.wall_telemetry_events.expires_at IS
  'Deleted by lib/wallTelemetryRetention.ts once passed. 30 days after the event (owner ruling Q11(a); migration 3702).';

COMMIT;

DO $post$
DECLARE
  def text;
  n   bigint;
BEGIN
  SELECT column_default INTO def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'wall_telemetry_events' AND column_name = 'expires_at';
  IF def IS NULL OR def !~ '30 days' OR def ~ '90 days' THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3702): wall_telemetry_events.expires_at default is %, not now() + 30 days.', coalesce(def, 'NULL');
  END IF;
  SELECT count(*) INTO n FROM public.wall_telemetry_events WHERE expires_at > occurred_at + interval '30 days';
  IF n > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3702): % row(s) of wall_telemetry_events still expire more than 30 days after the event.', n;
  END IF;
  IF has_table_privilege('anon', 'public.wall_telemetry_events', 'DELETE')
     OR has_table_privilege('authenticated', 'public.wall_telemetry_events', 'DELETE') THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED (3702): a client role can DELETE wall telemetry; only the service-role sweep may.';
  END IF;
  RAISE NOTICE '3702 postcondition: wall_telemetry_events defaults to 30 days and no row outlives occurred_at + 30 days.';
END $post$;
