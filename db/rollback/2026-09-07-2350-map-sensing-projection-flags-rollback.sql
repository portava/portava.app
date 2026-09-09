-- Rollback for 2350_map_sensing_projection_flags.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2350 DID
-- =============
-- Inserted three feature_flags rows, all FALSE, with ON CONFLICT DO NOTHING:
--
--   map_experience_state_enabled
--   map_world_moments_enabled
--   map_display_resolver_enabled
--
-- No DDL. No table, column, index, policy, grant or function. It did not touch
-- map_projection_enabled, map_crowd_flow_enabled or
-- map_world_intelligence_enabled, and neither does this rollback.
--
-- WHAT REMOVING THE ROWS DOES
-- ===========================
-- Nothing observable. `lib/featureFlags.isFlagEnabled` uses `maybeSingle()`, so
-- a MISSING row reads as `data = null, error = null` -> false — the same verdict
-- as the seeded FALSE row. All three readers (routes/mapProjection.ts,
-- routes/mapProjectionTemporal.ts) take exactly the same branch before and
-- after. The rows are a CONTROL SURFACE, not a behaviour: deleting them removes
-- an operator's ability to find and flip the switch, and removes nothing else.
--
-- ⚠ RUN THIS ONLY IF ALL THREE FLAGS ARE STILL OFF.
-- If someone has turned one ON, deleting the row silently turns the capability
-- OFF (missing reads as false) — a behaviour change disguised as a cleanup. The
-- guard below refuses in that case rather than doing it quietly. Decide
-- deliberately, set the flag to FALSE yourself, then re-run.
--
-- Idempotent: re-running after the rows are gone is a no-op.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
     WHERE flag IN ('map_experience_state_enabled', 'map_world_moments_enabled', 'map_display_resolver_enabled')
       AND enabled IS TRUE
  ) THEN
    RAISE EXCEPTION
      'REFUSING: a map sensing projection flag is ON. Deleting its row would silently disable the capability. Set it FALSE deliberately first, then re-run this rollback.';
  END IF;
END $$;

DELETE FROM public.feature_flags
 WHERE flag IN ('map_experience_state_enabled', 'map_world_moments_enabled', 'map_display_resolver_enabled');

COMMIT;
