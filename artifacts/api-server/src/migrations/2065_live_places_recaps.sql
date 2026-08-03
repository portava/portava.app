-- Phase 3: versioned Live Places Recaps.  A recap is an owner-controlled
-- archive; versions/snapshots are append-only so published travel history is
-- never silently rewritten by source edits or regeneration.
CREATE TABLE IF NOT EXISTS live_place_recaps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  place_day_id UUID REFERENCES place_days(id) ON DELETE RESTRICT,
  moment_id UUID REFERENCES shared_moments(id) ON DELETE RESTRICT,
  place_id UUID NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','published','archived','removed','restored')),
  current_version_id UUID,
  archived_at TIMESTAMPTZ, archived_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  removed_at TIMESTAMPTZ, removed_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  restored_at TIMESTAMPTZ, restored_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((place_day_id IS NOT NULL)::int + (moment_id IS NOT NULL)::int = 1)
);

CREATE TABLE IF NOT EXISTS live_place_recap_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recap_id UUID NOT NULL REFERENCES live_place_recaps(id) ON DELETE CASCADE,
  version_number INT NOT NULL CHECK (version_number > 0),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','reviewed','published','archived','removed','restored')),
  title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
  source_hash TEXT NOT NULL, place_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_by TEXT NOT NULL DEFAULT 'compass_grounded' CHECK (generated_by IN ('manual','compass_grounded')),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(), reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES profiles(id) ON DELETE SET NULL, published_at TIMESTAMPTZ,
  published_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  regenerates_version_id UUID REFERENCES live_place_recap_versions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (recap_id, version_number)
);
DO $$ BEGIN
  ALTER TABLE live_place_recaps ADD CONSTRAINT live_place_recaps_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES live_place_recap_versions(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS live_place_recap_chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES live_place_recap_versions(id) ON DELETE CASCADE,
  ordinal INT NOT NULL CHECK (ordinal >= 0), title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
  source_ids UUID[] NOT NULL DEFAULT '{}', origin TEXT NOT NULL DEFAULT 'compass_suggested'
    CHECK (origin IN ('manual','compass_suggested')), approved_at TIMESTAMPTZ,
  approved_by UUID REFERENCES profiles(id) ON DELETE SET NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version_id, ordinal)
);

CREATE TABLE IF NOT EXISTS live_place_recap_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES live_place_recap_versions(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('place_day_post','moment_contribution')),
  source_id UUID NOT NULL, post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
  contributor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  ordinal INT NOT NULL DEFAULT 0, provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE (version_id, source_type, source_id)
);

CREATE TABLE IF NOT EXISTS live_place_recap_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES live_place_recap_versions(id) ON DELETE CASCADE,
  source_id UUID NOT NULL, snapshot_kind TEXT NOT NULL CHECK (snapshot_kind IN ('place','post','media')),
  payload JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (version_id, source_id, snapshot_kind)
);
CREATE INDEX IF NOT EXISTS live_place_recaps_owner_context_idx ON live_place_recaps (owner_id, place_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS live_place_recap_versions_recap_idx ON live_place_recap_versions (recap_id, version_number DESC);
CREATE INDEX IF NOT EXISTS live_place_recap_sources_version_idx ON live_place_recap_sources (version_id, ordinal);

ALTER TABLE live_place_recaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_place_recap_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_place_recap_chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_place_recap_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE live_place_recap_snapshots ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS live_place_recaps_service_all ON live_place_recaps;
CREATE POLICY live_place_recaps_service_all ON live_place_recaps FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS live_place_recap_versions_service_all ON live_place_recap_versions;
CREATE POLICY live_place_recap_versions_service_all ON live_place_recap_versions FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS live_place_recap_chapters_service_all ON live_place_recap_chapters;
CREATE POLICY live_place_recap_chapters_service_all ON live_place_recap_chapters FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS live_place_recap_sources_service_all ON live_place_recap_sources;
CREATE POLICY live_place_recap_sources_service_all ON live_place_recap_sources FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS live_place_recap_snapshots_service_all ON live_place_recap_snapshots;
CREATE POLICY live_place_recap_snapshots_service_all ON live_place_recap_snapshots FOR ALL TO service_role USING (true) WITH CHECK (true);

INSERT INTO feature_flags (flag, enabled, description) VALUES
 ('place_recaps_enabled', FALSE, 'Versioned, owner-reviewed recaps for completed Place Days; requires external_places_enabled and place_days_enabled'),
 ('moment_recaps_enabled', FALSE, 'Versioned, owner-reviewed recaps for Shared Moments; requires Shared Moments capability')
ON CONFLICT (flag) DO NOTHING;