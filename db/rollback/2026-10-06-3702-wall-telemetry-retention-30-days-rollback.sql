-- Rollback for 3702_wall_telemetry_retention_30_days.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Restores 2308's 90-day DEFAULT on wall_telemetry_events. It does NOT lengthen
-- any row's expires_at, and it does not stop the sweep (lib/wallTelemetryRetention.ts
-- deletes on expires_at, whatever the default). ⚠ Rows written after it runs are
-- again kept 90 days, against OD-INPUT-2's 30 days (Q11(a) the analogue).

BEGIN;
ALTER TABLE public.wall_telemetry_events ALTER COLUMN expires_at SET DEFAULT (now() + interval '90 days');
COMMENT ON COLUMN public.wall_telemetry_events.expires_at IS NULL;
COMMIT;

DO $post$
DECLARE def text;
BEGIN
  SELECT column_default INTO def FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'wall_telemetry_events' AND column_name = 'expires_at';
  IF def IS NULL OR def !~ '90 days' THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3702): wall_telemetry_events.expires_at default is %.', coalesce(def, 'NULL');
  END IF;
END $post$;
