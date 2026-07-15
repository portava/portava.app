-- 0094_profile_account_status_and_privacy.sql
-- Adds three missing items referenced by live backend routes with no prior SQL file:
--   1. profiles.account_status     -- used by profile.ts (deactivate/reactivate/delete-request)
--                                     and admin.ts (GET /admin/users SELECT — no guard)
--   2. profile_privacy_settings    -- used by GET+PATCH /me/privacy; PATCH has no missing-table guard
--   3. user_deletion_requests      -- used by POST /me/delete-request (awaited; hard-fails if absent)
-- All statements are idempotent (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS).

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. profiles.account_status
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS account_status TEXT NOT NULL DEFAULT 'active';

-- Sync: if a user already has a deactivated row in user_account_states, mark
-- their profile accordingly so admin.ts SELECT returns a consistent value.
UPDATE profiles p
SET    account_status = 'deactivated'
FROM   user_account_states uas
WHERE  uas.user_id   = p.id
  AND  uas.state     = 'deactivated'
  AND  p.account_status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. profile_privacy_settings
-- ─────────────────────────────────────────────────────────────────────────────
-- Full schema derived from PRIVACY_DEFAULTS and patchPrivacySchema in profile.ts.

CREATE TABLE IF NOT EXISTS profile_privacy_settings (
  user_id                  UUID        NOT NULL
                             REFERENCES auth.users(id) ON DELETE CASCADE,
  profile_visibility       TEXT        NOT NULL DEFAULT 'public'
                             CHECK (profile_visibility IN ('public', 'followers_only', 'private')),
  show_current_city        BOOLEAN     NOT NULL DEFAULT TRUE,
  show_home_country        BOOLEAN     NOT NULL DEFAULT TRUE,
  show_visited_places      BOOLEAN     NOT NULL DEFAULT TRUE,
  show_upcoming_trips      BOOLEAN     NOT NULL DEFAULT TRUE,
  show_past_trips          BOOLEAN     NOT NULL DEFAULT TRUE,
  show_posts               BOOLEAN     NOT NULL DEFAULT TRUE,
  show_stamps              BOOLEAN     NOT NULL DEFAULT TRUE,
  show_friends             BOOLEAN     NOT NULL DEFAULT TRUE,
  show_followers           BOOLEAN     NOT NULL DEFAULT TRUE,
  allow_messages_from      TEXT        NOT NULL DEFAULT 'everyone'
                             CHECK (allow_messages_from IN ('everyone', 'friends', 'followers', 'nobody')),
  allow_friend_requests    BOOLEAN     NOT NULL DEFAULT TRUE,
  allow_follow             BOOLEAN     NOT NULL DEFAULT TRUE,
  allow_tagging            BOOLEAN     NOT NULL DEFAULT TRUE,
  allow_profile_discovery  BOOLEAN     NOT NULL DEFAULT TRUE,
  delayed_posting_default  BOOLEAN     NOT NULL DEFAULT FALSE,
  precise_location_visible BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at               TIMESTAMPTZ,
  PRIMARY KEY (user_id)
);

ALTER TABLE profile_privacy_settings ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS "pps_own" ON profile_privacy_settings;
  CREATE POLICY "pps_own" ON profile_privacy_settings
    FOR ALL
    USING     (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "pps_svc" ON profile_privacy_settings;
  CREATE POLICY "pps_svc" ON profile_privacy_settings
    FOR ALL
    USING (auth.role() = 'service_role');
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. user_deletion_requests
-- ─────────────────────────────────────────────────────────────────────────────
-- Columns derived from the upsert call in POST /me/delete-request (profile.ts):
--   { user_id, requested_at, scheduled_at, status: "pending" }

CREATE TABLE IF NOT EXISTS user_deletion_requests (
  user_id       UUID        NOT NULL
                  REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scheduled_at  TIMESTAMPTZ NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'cancelled', 'executed')),
  cancelled_at  TIMESTAMPTZ,
  executed_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id)
);

ALTER TABLE user_deletion_requests ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  DROP POLICY IF EXISTS "udr_own" ON user_deletion_requests;
  CREATE POLICY "udr_own" ON user_deletion_requests
    FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

DO $$ BEGIN
  DROP POLICY IF EXISTS "udr_svc" ON user_deletion_requests;
  CREATE POLICY "udr_svc" ON user_deletion_requests
    FOR ALL
    USING (auth.role() = 'service_role');
EXCEPTION WHEN undefined_table THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS udr_status_scheduled_idx
  ON user_deletion_requests (status, scheduled_at)
  WHERE status = 'pending';
