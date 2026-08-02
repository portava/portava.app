-- Phase 1: Place Days — one timezone-correct local calendar day per canonical place.
-- Source posts/media remain authoritative; this table only anchors lifecycle and navigation.

CREATE TABLE IF NOT EXISTS place_days (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  place_id UUID NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  local_date DATE NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closing', 'archived')),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closing_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (place_id, local_date)
);

CREATE INDEX IF NOT EXISTS place_days_place_date_idx ON place_days (place_id, local_date DESC);
CREATE INDEX IF NOT EXISTS place_days_lifecycle_idx ON place_days (status, local_date);

ALTER TABLE place_days ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS place_days_service_all ON place_days;
CREATE POLICY place_days_service_all ON place_days
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Direct client reads are deliberately not granted: routes apply post visibility,
-- block, and private-account rules at request time.
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('place_days_enabled', FALSE,
   'Timezone-correct canonical Place Day records and viewer-filtered place-day feeds; requires external_places_enabled')
ON CONFLICT (flag) DO NOTHING;