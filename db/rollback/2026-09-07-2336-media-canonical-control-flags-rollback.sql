-- Rollback for 2336_media_canonical_control_flags.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2336 DID
-- =============
-- Inserted two feature_flags rows, both FALSE, with ON CONFLICT DO NOTHING:
--
--   media_canonical_schema_fallback_enabled
--   media_canonical_read_enabled
--
-- No DDL. No table, column, index, policy, grant or function. It did not touch
-- `media_canonical_enabled` (TRUE in production, absent in CI) and neither does
-- this rollback.
--
-- WHAT REMOVING THE ROWS DOES
-- ===========================
-- Nothing observable. `lib/featureFlags.isFlagEnabled` uses `maybeSingle()`, so
-- a MISSING row reads as `data = null, error = null` -> false — the same verdict
-- as the seeded FALSE row. Both readers
-- (`lib/mediaAssets.recordMediaAssetDetailed`,
-- `lib/media/mediaCanonicalRead.attachCanonicalMedia`) therefore take exactly
-- the same branch before and after. The rows are a CONTROL SURFACE, not a
-- behaviour: deleting them removes an operator's ability to find and flip the
-- switch, and removes nothing else.
--
-- ⚠ RUN THIS ONLY IF BOTH FLAGS ARE STILL OFF.
-- If someone has turned one ON, deleting the row silently turns the capability
-- OFF (missing reads as false) — a behaviour change disguised as a cleanup, and
-- for `media_canonical_schema_fallback_enabled` that would stop canonical asset
-- writes that had started landing. The guard below refuses in that case rather
-- than doing it quietly. Decide deliberately, set the flag to FALSE yourself,
-- then re-run.
--
-- Idempotent: re-running after the rows are gone is a no-op.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
     WHERE flag IN ('media_canonical_schema_fallback_enabled', 'media_canonical_read_enabled')
       AND enabled IS TRUE
  ) THEN
    RAISE EXCEPTION
      'REFUSING: a media canonical control flag is ON. Deleting its row would silently disable the capability. Set it FALSE deliberately first, then re-run this rollback.';
  END IF;
END $$;

DELETE FROM public.feature_flags
 WHERE flag IN ('media_canonical_schema_fallback_enabled', 'media_canonical_read_enabled');

-- `media_canonical_enabled` is deliberately absent from that DELETE list.

COMMIT;
