-- Rollback for 2339_highlights_feed_bound.sql
-- Applied by hand to portava-ci (hwokxgbmezheskbzskfr) on 2026-09-07.
-- NOT applied to travel-buddy (ajrurzioarfkagpuxfnb).
--
-- WHAT 2339 DID
-- =============
-- Inserted ONE feature_flags row, FALSE, with ON CONFLICT DO NOTHING:
--   highlights_feed_bounded_enabled
-- No DDL of any kind.
--
-- WHAT REMOVING THE ROW DOES
-- ==========================
-- Nothing observable while the flag is FALSE. lib/featureFlags.isFlagEnabled
-- uses maybeSingle(), so a MISSING row reads as data = null, error = null ->
-- false — the same verdict as the seeded FALSE row, and GET
-- /highlights/following-feed takes the same (unbounded) branch either way. The
-- row is a CONTROL SURFACE, not a behaviour: deleting it removes an operator's
-- ability to find and flip the switch, and removes nothing else.
--
-- ⚠ RUN THIS ONLY IF THE FLAG IS STILL OFF. If someone turned it ON, deleting
-- the row silently turns the cap OFF again (missing reads as false) and the
-- feed goes back to unbounded — a behaviour change disguised as a cleanup.
-- The guard below refuses in that case.
--
-- Idempotent: re-running after the row is gone is a no-op.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.feature_flags
     WHERE flag = 'highlights_feed_bounded_enabled' AND enabled IS TRUE
  ) THEN
    RAISE EXCEPTION
      'REFUSING: highlights_feed_bounded_enabled is ON. Deleting its row silently returns the following-feed to unbounded. Set it FALSE deliberately first, then re-run this rollback.';
  END IF;
END $$;

DELETE FROM public.feature_flags WHERE flag = 'highlights_feed_bounded_enabled';

COMMIT;
