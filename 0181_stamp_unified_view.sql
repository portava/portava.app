-- Migration 0181: Stamp legacy unification (read-layer flag)
--
-- Portava has two live stamp systems that count separately by design:
--   v1  passport_stamps  — GPS/location stamps (the passport screen's count)
--   v2  user_stamps      — achievements, rarity, catalog art (the Stamps tab)
--
-- UnifiedStampService merges them into one deduplicated read collection.
-- This flag governs whether surfaces adopt the unified count:
--   OFF (default) — passport stat stays v1-only GPS count (current behavior).
--   ON            — passport stat shows the deduped v1+v2 total; the
--                   /stamps/me/unified endpoint is unaffected (always available).
--
-- NO schema change, NO data migration — the unification is purely a read-layer
-- merge keyed on the catalog_id that reconcile already backfills on BOTH tables
-- (falling back to stamp_type|country|city). Both write paths are untouched.
--
-- Safe to re-run. feature_flags PK column is `flag` (NOT `key`).

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('stamp_unified_view_enabled', FALSE,
   'Stamp legacy unification: report deduped v1 (GPS passport_stamps) + v2 (user_stamps) total on passport surfaces')
ON CONFLICT (flag) DO NOTHING;
