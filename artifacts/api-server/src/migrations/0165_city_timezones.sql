-- 0165: Persist learned city → IANA timezone entries so a server restart
-- doesn't reset brand-new cities to UTC. Entries are coordinate-derived
-- (offline tz-lookup) and loaded into the in-memory resolver on boot.
-- Service-role only — the API server is the sole reader/writer.

CREATE TABLE IF NOT EXISTS city_timezones (
  city_key   text        PRIMARY KEY,
  timezone   text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE city_timezones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "city_timezones_service_all" ON city_timezones;
CREATE POLICY "city_timezones_service_all" ON city_timezones
  FOR ALL TO service_role USING (true) WITH CHECK (true);
