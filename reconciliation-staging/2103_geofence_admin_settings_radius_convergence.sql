-- 2103_geofence_admin_settings_radius_convergence.sql
--
-- STATUS: STAGED — NOT APPLIED. reconciliation-staging/, outside canonical.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- BLOCKED ON: Q2 (column shape)
--
-- Q2 must confirm which of the three radius vocabularies below is actually
-- live on geofence_admin_settings before this file runs. The packet's own
-- manifest (§4.3) predicts canonical's unsuffixed `*_radius` names are NOT
-- live at all (0039_plan_geofence_full.sql is one of the files never proven
-- to have applied — see §3.2(d) corroboration via 0131). This migration's
-- precondition block enforces that prediction rather than assuming it: if
-- the unsuffixed names ARE live, the file aborts rather than silently
-- reconciling only two of three vocabularies.
--
-- ROLLBACK: derivable (backfill + relax, §8 item 9c) — see below.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- WHAT THIS RESOLVES
-- ==================
-- RECONCILIATION-PACKET.md §4.3 (MERGED_LIVE_SHAPE) and §7 row 2103. Three
-- vocabularies for the same three columns, all from the shared source file
-- 0039_plan_geofence_full.sql:
--
--   canonical (0039:56-62, predicted NOT LIVE): default_radius, min_radius,
--     max_radius — double precision, defaults 150/50/1000
--   legacy    (0039:163-169): default_radius_m, min_radius_m, max_radius_m
--     — integer NOT NULL, defaults 150/50/5000
--   root      (0039:80-86): default_radius_meters, min_radius_meters,
--     max_radius_meters — integer NOT NULL, defaults 200/50/5000
--
-- The packet designates `*_radius_m` (legacy's vocabulary) as canonical
-- going forward and `*_radius_meters` (root's) as the deprecated backfill
-- source. Defaults genuinely differ across all three (150/50/1000 vs
-- 150/50/5000 vs 200/50/5000) — this migration does not attempt to reconcile
-- DEFAULT values, only column presence and data; a default only affects rows
-- inserted without an explicit value, and this migration writes no new rows.
--
-- INTENDED FINAL STATE
-- =====================
-- `default_radius_m`, `min_radius_m`, `max_radius_m` exist and hold data
-- (backfilled from `*_radius_meters` wherever the `_m` column was null).
-- `*_radius_meters` columns, if present, have NOT NULL dropped and are
-- commented deprecated. No column is dropped. This migration takes no
-- position on the unsuffixed canonical names — see precondition.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.geofence_admin_settings') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: public.geofence_admin_settings does not exist live.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'geofence_admin_settings'
      AND column_name IN ('default_radius', 'min_radius', 'max_radius')
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: geofence_admin_settings carries canonical''s unsuffixed *_radius columns live, contradicting the manifest''s prediction that they never applied. This migration only reconciles *_radius_m vs *_radius_meters — a live unsuffixed set is a third vocabulary this file does not handle. Re-author after Q2 confirms the full picture.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'geofence_admin_settings'
      AND column_name IN ('default_radius_m', 'default_radius_meters')
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: neither default_radius_m nor default_radius_meters exists live. The live shape matches none of the three trees this file was authored against.';
  END IF;
END $$;

-- ── The change ───────────────────────────────────────────────────────────
ALTER TABLE public.geofence_admin_settings
  ADD COLUMN IF NOT EXISTS default_radius_m integer,
  ADD COLUMN IF NOT EXISTS min_radius_m     integer,
  ADD COLUMN IF NOT EXISTS max_radius_m     integer;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'geofence_admin_settings' AND column_name = 'default_radius_meters'
  ) THEN
    UPDATE public.geofence_admin_settings
       SET default_radius_m = default_radius_meters
     WHERE default_radius_m IS NULL AND default_radius_meters IS NOT NULL;
    UPDATE public.geofence_admin_settings
       SET min_radius_m = min_radius_meters
     WHERE min_radius_m IS NULL AND min_radius_meters IS NOT NULL;
    UPDATE public.geofence_admin_settings
       SET max_radius_m = max_radius_meters
     WHERE max_radius_m IS NULL AND max_radius_meters IS NOT NULL;

    EXECUTE 'ALTER TABLE public.geofence_admin_settings ALTER COLUMN default_radius_meters DROP NOT NULL';
    EXECUTE 'ALTER TABLE public.geofence_admin_settings ALTER COLUMN min_radius_meters DROP NOT NULL';
    EXECUTE 'ALTER TABLE public.geofence_admin_settings ALTER COLUMN max_radius_meters DROP NOT NULL';

    COMMENT ON COLUMN public.geofence_admin_settings.default_radius_meters IS 'Deprecated 2103 — superseded by default_radius_m. Root-tree vocabulary. Not dropped.';
    COMMENT ON COLUMN public.geofence_admin_settings.min_radius_meters     IS 'Deprecated 2103 — superseded by min_radius_m. Not dropped.';
    COMMENT ON COLUMN public.geofence_admin_settings.max_radius_meters     IS 'Deprecated 2103 — superseded by max_radius_m. Not dropped.';
  END IF;
END $$;

-- ── Postcondition ────────────────────────────────────────────────────────
DO $$
DECLARE
  unbackfilled int;
BEGIN
  SELECT count(*) INTO unbackfilled
    FROM public.geofence_admin_settings
   WHERE default_radius_m IS NULL OR min_radius_m IS NULL OR max_radius_m IS NULL;

  IF unbackfilled > 0 THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: % geofence_admin_settings rows still have a NULL *_radius_m column after backfill.', unbackfilled;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: service_role no longer has BYPASSRLS.';
  END IF;
END $$;

COMMIT;

-- ═══════════════════════════════════════════════════════════════════════════
-- ROLLBACK
-- ═══════════════════════════════════════════════════════════════════════════
-- ALTER TABLE public.geofence_admin_settings ALTER COLUMN default_radius_meters SET NOT NULL;
-- ALTER TABLE public.geofence_admin_settings ALTER COLUMN min_radius_meters     SET NOT NULL;
-- ALTER TABLE public.geofence_admin_settings ALTER COLUMN max_radius_meters     SET NOT NULL;
-- -- Check first — a non-zero count means the relax was load-bearing:
-- --   SELECT count(*) FROM public.geofence_admin_settings
-- --    WHERE default_radius_meters IS NULL OR min_radius_meters IS NULL OR max_radius_meters IS NULL;
-- -- The *_radius_m columns and their backfilled data are additive; leaving
-- -- them in place on rollback loses nothing.

-- ═══════════════════════════════════════════════════════════════════════════
-- VERIFICATION (run after apply)
-- ═══════════════════════════════════════════════════════════════════════════
-- SELECT count(*) FILTER (WHERE default_radius_m IS NULL) AS still_null
--   FROM public.geofence_admin_settings;                         -- expect 0
-- SELECT column_name, is_nullable FROM information_schema.columns
--  WHERE table_name = 'geofence_admin_settings'
--    AND column_name LIKE '%radius%'
--  ORDER BY column_name;
