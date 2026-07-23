-- Migration 0174: reference data — FX rates + country metadata
-- (Airports reference load reuses airport_profiles from 0127.)
-- Idempotent; RLS: authenticated read + service write. Safe to re-run.

CREATE TABLE IF NOT EXISTS fx_rates (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency CHAR(3)     NOT NULL,
  currency      CHAR(3)     NOT NULL,
  rate          NUMERIC     NOT NULL CHECK (rate > 0),
  rate_date     DATE        NOT NULL,
  source        TEXT        NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (base_currency, currency, rate_date)
);
CREATE INDEX IF NOT EXISTS fx_rates_currency_date_idx ON fx_rates (currency, rate_date DESC);
ALTER TABLE fx_rates ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fx_rates' AND policyname='fx_rates_read') THEN
    CREATE POLICY fx_rates_read ON fx_rates FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='fx_rates' AND policyname='fx_rates_svc') THEN
    CREATE POLICY fx_rates_svc ON fx_rates FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS country_metadata (
  code          CHAR(2)     PRIMARY KEY,
  name          TEXT        NOT NULL,
  official_name TEXT,
  region        TEXT,
  capital       TEXT,
  currencies    JSONB       NOT NULL DEFAULT '{}',
  languages     JSONB       NOT NULL DEFAULT '{}',
  calling_codes JSONB       NOT NULL DEFAULT '[]',
  flag_emoji    TEXT,
  source        TEXT        NOT NULL,
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE country_metadata ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='country_metadata' AND policyname='country_metadata_read') THEN
    CREATE POLICY country_metadata_read ON country_metadata FOR SELECT TO authenticated USING (true);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='country_metadata' AND policyname='country_metadata_svc') THEN
    CREATE POLICY country_metadata_svc ON country_metadata FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
