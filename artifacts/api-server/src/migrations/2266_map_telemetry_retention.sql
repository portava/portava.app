-- Enforce the 90-day Map telemetry expiry declared in migration 2202.
-- Collection and retention have separate flags: turning collection off must not
-- strand already-expired behavioural rows. The scheduler calls this bounded,
-- idempotent function hourly only when the retention flag is enabled.

BEGIN;

CREATE OR REPLACE FUNCTION public.purge_expired_map_telemetry()
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  event_count bigint := 0;
  drop_count bigint := 0;
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

INSERT INTO public.feature_flags (flag, enabled, description) VALUES
  (
    'map_telemetry_retention_enabled',
    TRUE,
    'Enforces the 90-day Map telemetry retention policy by purging expired event and drop-counter rows.'
  )
ON CONFLICT (flag) DO UPDATE SET enabled = TRUE;

COMMIT;