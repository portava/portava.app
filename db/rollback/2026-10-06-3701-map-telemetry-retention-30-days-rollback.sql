-- Rollback for 3701_map_telemetry_retention_30_days.sql
-- NOT applied to portava-ci (hwokxgbmezheskbzskfr) at the time of writing.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- Restores 2202's 90-day DEFAULT on map_telemetry_events and map_telemetry_drops.
-- It does NOT lengthen any row's expires_at: rows 3701 shortened keep their
-- 30-day expiry, because extending retention of identifiable rows after the
-- fact is not something a rollback should do silently.
--
-- ⚠ Re-opens the gap against OD-INPUT-2's 30 days for per-user behavioural
-- data (Q11(a) the analogue) for every row written after it runs.

BEGIN;
ALTER TABLE public.map_telemetry_events ALTER COLUMN expires_at SET DEFAULT (now() + interval '90 days');
ALTER TABLE public.map_telemetry_drops  ALTER COLUMN expires_at SET DEFAULT (now() + interval '90 days');
COMMIT;

DO $post$
DECLARE
  t text; def text;
BEGIN
  FOREACH t IN ARRAY ARRAY['map_telemetry_events','map_telemetry_drops'] LOOP
    SELECT column_default INTO def FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = t AND column_name = 'expires_at';
    IF def IS NULL OR def !~ '90 days' THEN
      RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED (3701): public.%.expires_at default is %.', t, coalesce(def, 'NULL');
    END IF;
  END LOOP;
END $post$;
