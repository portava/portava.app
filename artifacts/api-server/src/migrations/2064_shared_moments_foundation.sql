-- Phase 2: Shared Moments.  Moments are explicit consent records over existing
-- Place Days, places, trips, posts, and media; source records are never copied.

CREATE TABLE IF NOT EXISTS shared_moments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  place_day_id UUID REFERENCES place_days(id) ON DELETE SET NULL,
  place_id UUID REFERENCES places(id) ON DELETE SET NULL,
  trip_id UUID REFERENCES trips(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 140),
  description TEXT CHECK (description IS NULL OR char_length(description) <= 1000),
  join_policy TEXT NOT NULL DEFAULT 'invite_only' CHECK (join_policy IN ('invite_only','approval_required')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (place_day_id IS NOT NULL OR place_id IS NOT NULL OR trip_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS shared_moment_memberships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id UUID NOT NULL REFERENCES shared_moments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','manager','member')),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','requested','accepted','declined','left','removed')),
  invited_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  responded_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (moment_id, user_id)
);

CREATE TABLE IF NOT EXISTS shared_moment_contributions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id UUID NOT NULL REFERENCES shared_moments(id) ON DELETE CASCADE,
  contributor_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  post_id UUID REFERENCES posts(id) ON DELETE SET NULL,
  media_asset_id UUID REFERENCES media_assets(id) ON DELETE SET NULL,
  caption TEXT CHECK (caption IS NULL OR char_length(caption) <= 1000),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','removed')),
  approved_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  approved_at TIMESTAMPTZ,
  removed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (post_id IS NOT NULL OR media_asset_id IS NOT NULL OR caption IS NOT NULL),
  UNIQUE NULLS NOT DISTINCT (moment_id, contributor_id, post_id, media_asset_id)
);

CREATE TABLE IF NOT EXISTS shared_moment_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id UUID REFERENCES shared_moments(id) ON DELETE CASCADE,
  recipient_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('compass','clustering')),
  reason TEXT NOT NULL CHECK (char_length(reason) <= 300),
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','accepted','dismissed','expired')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS shared_moment_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id UUID NOT NULL REFERENCES shared_moments(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shared_moments_context_idx ON shared_moments (place_day_id, place_id, trip_id, status);
CREATE INDEX IF NOT EXISTS shared_moment_memberships_user_idx ON shared_moment_memberships (user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS shared_moment_contributions_feed_idx ON shared_moment_contributions (moment_id, status, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS shared_moment_suggestions_recipient_idx ON shared_moment_suggestions (recipient_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS shared_moment_audit_events_moment_idx ON shared_moment_audit_events (moment_id, created_at DESC);

ALTER TABLE shared_moments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_moment_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_moment_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_moment_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_moment_audit_events ENABLE ROW LEVEL SECURITY;

-- Direct client access is intentionally denied. API routes use service role and
-- apply membership, block, source-privacy, and lifecycle checks in one place.
DO $$ BEGIN
  CREATE POLICY shared_moments_service_all ON shared_moments FOR ALL TO service_role USING (true) WITH CHECK (true);
  CREATE POLICY shared_moment_memberships_service_all ON shared_moment_memberships FOR ALL TO service_role USING (true) WITH CHECK (true);
  CREATE POLICY shared_moment_contributions_service_all ON shared_moment_contributions FOR ALL TO service_role USING (true) WITH CHECK (true);
  CREATE POLICY shared_moment_suggestions_service_all ON shared_moment_suggestions FOR ALL TO service_role USING (true) WITH CHECK (true);
  CREATE POLICY shared_moment_audit_events_service_all ON shared_moment_audit_events FOR ALL TO service_role USING (true) WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('shared_moments_enabled', FALSE, 'Explicit, consent-based Shared Moments; requires external_places_enabled and place_days_enabled'),
  ('shared_moments_compass_suggestions_enabled', FALSE, 'Explainable opt-in Shared Moment suggestions from Compass'),
  ('shared_moments_clustering_enabled', FALSE, 'Explicit candidate clustering suggestions for Shared Moments'),
  ('shared_moments_chat_enabled', FALSE, 'Shared Moment chat capability when supported by the reused group-chat foundation')
ON CONFLICT (flag) DO NOTHING;