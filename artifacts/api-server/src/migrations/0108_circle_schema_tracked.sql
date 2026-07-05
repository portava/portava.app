-- Find Your Circle — Canonical Migration 0108
--
-- This file consolidates circle presence/coordination schema that was previously
-- applied to production Supabase via the non-canonical migrations directory
-- (artifacts/api-server/migrations/0115–0122). All statements are idempotent
-- and safe to re-apply on a database that already has these tables.
--
-- Tables created:
--   1. circle_visibility_settings  — per-user global opt-in + consent
--   2. circle_context_settings     — per-trip/event override settings
--   3. circle_presence             — current presence snapshot (upserted)
--   4. circle_checkins             — immutable check-in event log
--   5. circle_member_visibility_overrides — per-pair hide controls
--   6. circle_meeting_points       — host-shared meeting location
--   7. circle_audit_events         — immutable 11-event-type audit log
--
-- RLS summary:
--   • All tables require service_role for writes from the API server.
--   • circle_visibility_settings / circle_context_settings: owner reads + writes.
--   • circle_presence: owner reads own row; service_role reads all (needed for
--     building the members list for co-members).
--   • circle_checkins: owner reads own rows only; owner inserts.
--   • circle_member_visibility_overrides: owner all.
--   • circle_meeting_points: service_role all; NO direct-user DB read — the API
--     layer enforces circle membership before returning meeting point data.
--   • circle_audit_events: actor/target read own rows; service_role writes all.
--
-- Privacy contract:
--   The "member list" join (who can see whose presence in a context) is enforced
--   at the API layer (artifacts/api-server/src/routes/circle.ts), not at the DB
--   RLS level. The service_role client is used for all presence reads so the API
--   can apply context-aware visibility rules (overrides, paused states, etc.)
--   before returning data to the caller.

-- ---------------------------------------------------------------------------
-- 1. circle_visibility_settings
--    Per-user global opt-in: must be enabled=true before any presence is shared.
--    Migration 0122 added the global-pause and per-type sharing default columns.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS circle_visibility_settings (
  user_id               UUID PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
  global_enabled        BOOLEAN NOT NULL DEFAULT false,
  visibility_mode       TEXT NOT NULL DEFAULT 'status_only'
                        CHECK (visibility_mode IN ('status_only','approximate_area','venue_checkin','precise_live')),
  trip_sharing_default  TEXT NOT NULL DEFAULT 'status_only',
  event_sharing_default TEXT NOT NULL DEFAULT 'status_only',
  is_paused             BOOLEAN NOT NULL DEFAULT false,
  paused_until          TIMESTAMPTZ,
  consent_version       TEXT,
  consented_at          TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE circle_visibility_settings
  DROP CONSTRAINT IF EXISTS circle_vis_trip_default_check;
ALTER TABLE circle_visibility_settings
  ADD CONSTRAINT circle_vis_trip_default_check
    CHECK (trip_sharing_default IN ('off', 'status_only', 'approximate_area', 'venue_checkin'));

ALTER TABLE circle_visibility_settings
  DROP CONSTRAINT IF EXISTS circle_vis_event_default_check;
ALTER TABLE circle_visibility_settings
  ADD CONSTRAINT circle_vis_event_default_check
    CHECK (event_sharing_default IN ('off', 'status_only', 'approximate_area', 'venue_checkin'));

-- If the table was already created without the newer columns, add them now.
ALTER TABLE circle_visibility_settings
  ADD COLUMN IF NOT EXISTS trip_sharing_default  TEXT NOT NULL DEFAULT 'status_only',
  ADD COLUMN IF NOT EXISTS event_sharing_default TEXT NOT NULL DEFAULT 'status_only',
  ADD COLUMN IF NOT EXISTS is_paused             BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS paused_until          TIMESTAMPTZ;

ALTER TABLE circle_visibility_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cvs_owner_all ON circle_visibility_settings;
CREATE POLICY cvs_owner_all ON circle_visibility_settings
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cvs_service_all ON circle_visibility_settings;
CREATE POLICY cvs_service_all ON circle_visibility_settings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Feature flags seeded by the original migration
INSERT INTO feature_flags (flag, enabled, description)
VALUES ('find_your_circle_enabled', false, 'Find Your Circle — opt-in status presence coordination')
ON CONFLICT (flag) DO NOTHING;

INSERT INTO feature_flags (flag, enabled, description)
VALUES ('find_your_circle_disabled', false, 'Emergency kill switch — disables all Find Your Circle endpoints')
ON CONFLICT (flag) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. circle_context_settings
--    Per-trip / per-event override settings for a user's circle presence.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS circle_context_settings (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type             TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id               UUID NOT NULL,
  enabled                  BOOLEAN NOT NULL DEFAULT true,
  visibility_mode_override TEXT CHECK (
    visibility_mode_override IS NULL OR
    visibility_mode_override IN ('status_only','approximate_area','venue_checkin','precise_live')
  ),
  paused                   BOOLEAN NOT NULL DEFAULT false,
  paused_until             TIMESTAMPTZ,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, context_type, context_id)
);

CREATE INDEX IF NOT EXISTS ccs_context_idx
  ON circle_context_settings (context_type, context_id);

ALTER TABLE circle_context_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccs_owner_all ON circle_context_settings;
CREATE POLICY ccs_owner_all ON circle_context_settings
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ccs_service_all ON circle_context_settings;
CREATE POLICY ccs_service_all ON circle_context_settings
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 3. circle_presence
--    Current presence snapshot per user per context (upserted on each push).
--    No GPS coordinates stored in V1.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS circle_presence (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type      TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id        UUID NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','arrived','with_group','leaving','safe','needs_help')),
  status_label      TEXT,
  approximate_label TEXT,
  venue_label       TEXT,
  checked_in        BOOLEAN NOT NULL DEFAULT false,
  stale_after_secs  INTEGER NOT NULL DEFAULT 1800,
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ,
  is_stale          BOOLEAN NOT NULL DEFAULT false,
  needs_help        BOOLEAN NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, context_type, context_id)
);

CREATE INDEX IF NOT EXISTS cp_context_idx
  ON circle_presence (context_type, context_id);

CREATE INDEX IF NOT EXISTS cp_expires_at_idx
  ON circle_presence (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS cp_last_seen_idx
  ON circle_presence (last_seen_at);

ALTER TABLE circle_presence ENABLE ROW LEVEL SECURITY;

-- Users read only their own row; the API service role reads all rows to build
-- the members list for co-members after applying visibility rules.
DROP POLICY IF EXISTS cp_owner_read ON circle_presence;
CREATE POLICY cp_owner_read ON circle_presence
  FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS cp_owner_write ON circle_presence;
CREATE POLICY cp_owner_write ON circle_presence
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cp_service_all ON circle_presence;
CREATE POLICY cp_service_all ON circle_presence
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 4. circle_checkins
--    Immutable check-in event log. Presence snapshot (circle_presence) is
--    updated alongside each insert; this table is the audit trail.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS circle_checkins (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type      TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id        UUID NOT NULL,
  checkin_type      TEXT NOT NULL
                    CHECK (checkin_type IN ('arrived','with_group','leaving','safe','needs_help')),
  note              TEXT,
  venue_label       TEXT,
  approximate_label TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ccin_user_context_idx
  ON circle_checkins (user_id, context_type, context_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ccin_context_idx
  ON circle_checkins (context_type, context_id, created_at DESC);

ALTER TABLE circle_checkins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ccin_owner_read ON circle_checkins;
CREATE POLICY ccin_owner_read ON circle_checkins
  FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS ccin_owner_insert ON circle_checkins;
CREATE POLICY ccin_owner_insert ON circle_checkins
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS ccin_service_all ON circle_checkins;
CREATE POLICY ccin_service_all ON circle_checkins
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 5. circle_member_visibility_overrides
--    Lets a user hide a specific person from their circle view, or hide
--    themselves from a specific person, within a given context.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS circle_member_visibility_overrides (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  target_user_id  UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  context_type    TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id      UUID NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('hide_from_me', 'hide_me_from')),
  hidden          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, target_user_id, context_type, context_id, direction)
);

CREATE INDEX IF NOT EXISTS cmvo_user_context_idx
  ON circle_member_visibility_overrides (user_id, context_type, context_id);

CREATE INDEX IF NOT EXISTS cmvo_target_context_idx
  ON circle_member_visibility_overrides (target_user_id, context_type, context_id);

ALTER TABLE circle_member_visibility_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cmvo_owner_all ON circle_member_visibility_overrides;
CREATE POLICY cmvo_owner_all ON circle_member_visibility_overrides
  FOR ALL
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS cmvo_service_all ON circle_member_visibility_overrides;
CREATE POLICY cmvo_service_all ON circle_member_visibility_overrides
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 6. circle_meeting_points
--    Meeting point shared by a trip/event host with the circle.
--    One active meeting point per context at a time (enforced at API layer).
--    ALL DB-level access is service-role only — membership gate is in the API.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS circle_meeting_points (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context_type      TEXT NOT NULL CHECK (context_type IN ('trip', 'event')),
  context_id        UUID NOT NULL,
  host_user_id      UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  venue_label       TEXT,
  approximate_label TEXT,
  description       TEXT,
  is_active         BOOLEAN NOT NULL DEFAULT true,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cmp_context_active_idx
  ON circle_meeting_points (context_type, context_id, is_active);

ALTER TABLE circle_meeting_points ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cmp_public_read ON circle_meeting_points;

DROP POLICY IF EXISTS cmp_service_all ON circle_meeting_points;
CREATE POLICY cmp_service_all ON circle_meeting_points
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- 7. circle_audit_events
--    Immutable audit log for all significant Circle lifecycle events.
--    Written by the API server (service role) only.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS circle_audit_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  target_user_id  UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  context_type    TEXT CHECK (context_type IN ('trip', 'event')),
  context_id      UUID,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'sharing_enabled',
    'sharing_disabled',
    'visibility_mode_changed',
    'presence_paused',
    'presence_resumed',
    'checkin_created',
    'needs_help_triggered',
    'admin_disabled_context',
    'host_changed_meeting_point',
    'consent_accepted',
    'admin_kill_switch_toggled'
  )),
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cae_actor_idx
  ON circle_audit_events (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS cae_target_idx
  ON circle_audit_events (target_user_id, created_at DESC)
  WHERE target_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cae_context_idx
  ON circle_audit_events (context_type, context_id, created_at DESC)
  WHERE context_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS cae_event_type_idx
  ON circle_audit_events (event_type, created_at DESC);

ALTER TABLE circle_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cae_actor_read ON circle_audit_events;
CREATE POLICY cae_actor_read ON circle_audit_events
  FOR SELECT
  USING (actor_user_id = auth.uid() OR target_user_id = auth.uid());

DROP POLICY IF EXISTS cae_service_all ON circle_audit_events;
CREATE POLICY cae_service_all ON circle_audit_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
