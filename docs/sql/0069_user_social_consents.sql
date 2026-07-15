-- ============================================================
-- 0069_user_social_consents.sql
-- Policy / consent version tracking per user.
-- Records that the user accepted a specific policy version.
-- One row per (user_id, consent_type, policy_version) — a new
-- policy version produces a new row rather than updating the old one.
-- ============================================================

DO $$ BEGIN
  CREATE TYPE consent_type AS ENUM (
    'interaction_terms',
    'community_guidelines',
    'privacy_policy',
    'age_verification',
    'location_sharing',
    'data_processing'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── Table ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_social_consents (
  id              uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid         NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  consent_type    consent_type NOT NULL,
  -- Semantic version string e.g. '2.1'
  policy_version  text         NOT NULL,
  accepted_at     timestamptz  NOT NULL DEFAULT now(),
  -- SHA-256 hash of the originating IP — stored for audit, never the raw IP
  ip_hash         text,
  metadata        jsonb        NOT NULL DEFAULT '{}',
  CONSTRAINT user_social_consents_unique UNIQUE (user_id, consent_type, policy_version)
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_social_consents_user_id
  ON user_social_consents (user_id);

CREATE INDEX IF NOT EXISTS idx_social_consents_type_version
  ON user_social_consents (consent_type, policy_version);

CREATE INDEX IF NOT EXISTS idx_social_consents_accepted_at
  ON user_social_consents (accepted_at DESC);

-- ── RLS ──────────────────────────────────────────────────────
ALTER TABLE user_social_consents ENABLE ROW LEVEL SECURITY;

-- Users read only their own consent records
DROP POLICY IF EXISTS "social_consents_select_own" ON user_social_consents;
CREATE POLICY "social_consents_select_own"
  ON user_social_consents FOR SELECT
  USING (user_id = auth.uid());

-- Users insert their own consent records
DROP POLICY IF EXISTS "social_consents_insert_own" ON user_social_consents;
CREATE POLICY "social_consents_insert_own"
  ON user_social_consents FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- No UPDATE or DELETE — consent records are append-only

-- ── Verification ─────────────────────────────────────────────
-- SELECT column_name, data_type
-- FROM information_schema.columns
-- WHERE table_schema = 'public' AND table_name = 'user_social_consents'
-- ORDER BY ordinal_position;
