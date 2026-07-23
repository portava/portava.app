-- Migration 0171: price baselines for Budget Intelligence
--
-- Curated per-day cost baselines used by GET /trips/:tripId/cost-estimate and
-- the budget sandbox. Rows are ADMIN-CURATED ONLY (see /admin/price-baselines
-- CRUD) — this migration intentionally seeds ZERO data rows so the API never
-- reports numbers nobody verified. With no rows present, estimates honestly
-- return { available: false, reason: 'no_baseline_data' }.
--
-- Scope resolution (most specific wins at read time):
--   city-level    → country + city set
--   country-level → country set, city NULL
--   global        → country NULL, city NULL
--
-- Safe to re-run: IF NOT EXISTS / ON CONFLICT DO NOTHING throughout.

CREATE TABLE IF NOT EXISTS price_baselines (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  country          CHAR(2)     NULL,             -- ISO 3166-1 alpha-2; NULL = not country-scoped
  city             TEXT        NULL,             -- NULL = not city-scoped
  category         TEXT        NOT NULL
    CHECK (category IN ('lodging', 'food', 'transport', 'activities', 'nightlife', 'other')),
  tier             TEXT        NOT NULL
    CHECK (tier IN ('budget', 'comfortable', 'upscale', 'luxury')),
  daily_amount     NUMERIC(12,2) NOT NULL CHECK (daily_amount >= 0),
  currency         CHAR(3)     NOT NULL DEFAULT 'USD',
  source_note      TEXT        NULL,             -- where the number came from (honesty trail)
  confidence       TEXT        NOT NULL DEFAULT 'curated',
  last_verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_by      UUID        NULL,             -- admin who last verified (auth.users id)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (scope, category, tier). Plain UNIQUE treats NULLs as distinct,
-- so use a COALESCE('') expression index to make NULL scopes participate.
CREATE UNIQUE INDEX IF NOT EXISTS price_baselines_scope_uniq
  ON price_baselines (COALESCE(country, ''), COALESCE(city, ''), category, tier);

CREATE INDEX IF NOT EXISTS price_baselines_city_idx    ON price_baselines (city);
CREATE INDEX IF NOT EXISTS price_baselines_country_idx ON price_baselines (country);

ALTER TABLE price_baselines ENABLE ROW LEVEL SECURITY;

-- Baselines are non-sensitive reference data: any authenticated user may read.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'price_baselines' AND policyname = 'price_baselines_read'
  ) THEN
    CREATE POLICY price_baselines_read ON price_baselines
      FOR SELECT TO authenticated USING (true);
  END IF;
END $$;

-- Writes go through the service role only (admin CRUD routes).
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'price_baselines' AND policyname = 'price_baselines_svc'
  ) THEN
    CREATE POLICY price_baselines_svc ON price_baselines
      FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

-- ── Feature flag ──────────────────────────────────────────────────────────────
-- NOTE: feature_flags PK column is `flag` (0037), never `key`.

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('budget_intelligence_enabled', false, 'Trip cost estimates + budget sandbox')
ON CONFLICT (flag) DO NOTHING;
