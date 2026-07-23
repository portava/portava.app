-- Migration 0168: discovery persistent-cache DDL (reconciliation)
--
-- lib/discoveryPersistentCache.ts reads/writes discovery_cache and
-- discovery_geocode_cache, but no migration in the canonical chain ever
-- declared them (the L2 layer fails soft, so a missing table silently
-- degrades to L1-only caching). This declares both tables to match the code's
-- exact column usage. Safe to re-run.
--
-- Service-role access only (API server); RLS enabled with no user policies —
-- cache rows are internal and never user-readable via PostgREST.

CREATE TABLE IF NOT EXISTS discovery_cache (
  cache_key       TEXT        PRIMARY KEY,
  destination     TEXT,
  category        TEXT,
  radius_km       NUMERIC,
  places          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  geocode_lat     DOUBLE PRECISION,
  geocode_lng     DOUBLE PRECISION,
  geocode_display TEXT,
  cached_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_cache_expires_idx
  ON discovery_cache (expires_at);

ALTER TABLE discovery_cache ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'discovery_cache' AND policyname = 'dc_svc'
  ) THEN
    CREATE POLICY dc_svc ON discovery_cache FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS discovery_geocode_cache (
  location_key TEXT        PRIMARY KEY,
  lat          DOUBLE PRECISION NOT NULL,
  lng          DOUBLE PRECISION NOT NULL,
  display_name TEXT,
  cached_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS discovery_geocode_cache_expires_idx
  ON discovery_geocode_cache (expires_at);

ALTER TABLE discovery_geocode_cache ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'discovery_geocode_cache' AND policyname = 'dgc_svc'
  ) THEN
    CREATE POLICY dgc_svc ON discovery_geocode_cache FOR ALL USING (auth.role() = 'service_role');
  END IF;
END $$;
