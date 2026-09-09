-- Rollback for 2338_memory_location_precision.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb) — 2338 was never applied there.
--
-- WHAT 2338 DID
-- =============
--   1. ALTER TABLE public.memories ADD COLUMN location_precision text
--        NOT NULL DEFAULT 'exact', plus CHECK memories_location_precision_check.
--   2. CREATE FUNCTION public.memory_public_feed(uuid, integer, timestamptz),
--        SECURITY INVOKER, EXECUTE granted to service_role only.
--   3. Two feature_flags rows, both FALSE:
--        memory_location_precision_enabled
--        memory_public_feed_projection_enabled
--
-- ⚠ ORDER MATTERS, AND SO DOES THE FLAG STATE.
-- ================================================
-- Dropping the column while `memory_location_precision_enabled` is TRUE would
-- make routes/memories.ts name a column that no longer exists. In PostgREST one
-- unknown column fails the WHOLE statement, so the memories read paths would
-- return PGRST100 (zero rows, not an error the user can read) and Memory
-- creation would return PGRST204 — a total outage of the surface, caused by a
-- cleanup. The guard below refuses in that case rather than doing it quietly.
-- Set the flags FALSE deliberately, deploy, THEN run this.
--
-- DROPPING THE COLUMN DESTROYS DATA. If any owner has set a precision other
-- than 'exact', that choice is their privacy decision and dropping the column
-- silently republishes their Memory at full precision. The guard refuses that
-- too. Decide deliberately: either accept the loss by setting those rows back
-- to 'exact' yourself, or keep the column.
--
-- Idempotent: re-running after the column, function and rows are gone is a no-op.

BEGIN;

DO $$
DECLARE
  n_narrowed integer;
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
     WHERE flag IN ('memory_location_precision_enabled', 'memory_public_feed_projection_enabled')
       AND enabled IS TRUE
  ) THEN
    RAISE EXCEPTION
      'REFUSING: a 2338 control flag is still ON. Dropping the column/function underneath a live reader takes the memories surface down. Set both flags FALSE, deploy, then re-run this rollback.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'memories'
       AND column_name = 'location_precision'
  ) THEN
    SELECT count(*) INTO n_narrowed
      FROM public.memories WHERE location_precision <> 'exact';
    IF n_narrowed > 0 THEN
      RAISE EXCEPTION
        'REFUSING: % memories carry an owner-narrowed location_precision. Dropping the column republishes them at full precision — a privacy regression disguised as a cleanup. Reset them to ''exact'' deliberately first, then re-run.', n_narrowed;
    END IF;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.memory_public_feed(uuid, integer, timestamptz);

ALTER TABLE public.memories
  DROP CONSTRAINT IF EXISTS memories_location_precision_check;

ALTER TABLE public.memories
  DROP COLUMN IF EXISTS location_precision;

DELETE FROM public.feature_flags
 WHERE flag IN ('memory_location_precision_enabled', 'memory_public_feed_projection_enabled');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'memories'
       AND column_name = 'location_precision'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: memories.location_precision still present';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'memory_public_feed'
  ) THEN
    RAISE EXCEPTION 'ROLLBACK POSTCONDITION FAILED: public.memory_public_feed() still present';
  END IF;
END $$;

COMMIT;
