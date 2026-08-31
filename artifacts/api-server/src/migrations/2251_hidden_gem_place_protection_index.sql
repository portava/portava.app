-- 2251_hidden_gem_place_protection_index.sql
--
-- Media v2 — Phase 1b (Security). Supports the media-location cross-check that
-- closes the Hidden-Gem de-anonymization hole (lib/mediaLocationVisibility
-- .loadRestrictiveGems): every media-serving seam that could disclose a
-- location now asks, once per request, "do any RESTRICTIVE, live Hidden Gems
-- share these canonical places or cities?" so it can coarsen media that sits at
-- / near a protected gem.
--
-- This migration is ADDITIVE + IDEMPOTENT (indexes only; no data, no column,
-- no policy change). It makes that lookup an index scan instead of a table scan
-- as the gem corpus grows. Nothing a user sees changes.
--
-- WHY THESE TWO PARTIAL INDEXES
--   loadRestrictiveGems filters on:
--       status IN ('active','pending','hidden')
--       AND sensitivity_level IN
--           ('protected','approximate','reveal_after_save','reveal_after_acceptance')
--       AND (canonical_place_id IN (...) OR city IN (...))
--   The two partial indexes below cover each arm of that OR, and the partial
--   predicate keeps them tiny — restrictive gems are the rare minority; the
--   common 'public' gem is excluded from the index entirely.
--
-- 0043_hidden_gems.sql already indexes (city) and (status) individually; those
-- do NOT cover the sensitivity filter, so a query for "restrictive gems in
-- these places" would still scan. These partial indexes do.

BEGIN;

-- ── Precondition ─────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF to_regclass('public.hidden_gems') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: hidden_gems missing — apply 0043_hidden_gems.sql first.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='hidden_gems' AND column_name='canonical_place_id'
  ) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: hidden_gems.canonical_place_id missing — apply 2044_hidden_gems_canonical_place_id.sql first.';
  END IF;
END $$;

-- ── Index by canonical place (place-linkage arm) ─────────────────────────────
CREATE INDEX IF NOT EXISTS hidden_gems_restrictive_place_idx
  ON hidden_gems (canonical_place_id)
  WHERE canonical_place_id IS NOT NULL
    AND status IN ('active','pending','hidden')
    AND sensitivity_level IN
        ('protected','approximate','reveal_after_save','reveal_after_acceptance');

-- ── Index by city (proximity-scoping arm) ────────────────────────────────────
CREATE INDEX IF NOT EXISTS hidden_gems_restrictive_city_idx
  ON hidden_gems (city)
  WHERE status IN ('active','pending','hidden')
    AND sensitivity_level IN
        ('protected','approximate','reveal_after_save','reveal_after_acceptance');

-- ── Postcondition — prove both indexes exist ─────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='hidden_gems_restrictive_place_idx'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: hidden_gems_restrictive_place_idx not created';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='hidden_gems_restrictive_city_idx'
  ) THEN
    RAISE EXCEPTION 'POSTCONDITION FAILED: hidden_gems_restrictive_city_idx not created';
  END IF;
END $$;

COMMIT;

-- REVERSAL (manual; indexes are safe to leave):
--   DROP INDEX IF EXISTS hidden_gems_restrictive_place_idx;
--   DROP INDEX IF EXISTS hidden_gems_restrictive_city_idx;
