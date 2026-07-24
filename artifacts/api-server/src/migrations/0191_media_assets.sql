-- Migration 0190: canonical media layer + media moderation subject + flag
--
-- Phase 1.5 of the media Phase 0 audit. Adds:
--   1. media_assets       — one canonical row per uploaded file (spec §9)
--   2. media_attachments  — asset ↔ entity links (no metadata duplication)
--   3. moderation_reports subject_type gains 'media'
--   4. feature flag media_canonical_enabled (OFF — dual-write stays dark)
-- Additive + idempotent; no existing table/column is altered besides the
-- moderation CHECK (recreated with a superset list). Safe to re-run.

CREATE TABLE IF NOT EXISTS media_assets (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  uploader_user_id  UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  storage_bucket    TEXT        NOT NULL,
  storage_path      TEXT        NOT NULL,
  public_url        TEXT,
  media_type        TEXT        NOT NULL CHECK (media_type IN ('image','video')),
  mime_type         TEXT        NOT NULL,
  size_bytes        BIGINT      NOT NULL DEFAULT 0,
  width             INTEGER,
  height            INTEGER,
  duration_ms       INTEGER,
  thumbnail_path    TEXT,
  thumbnail_url     TEXT,
  alt_text          TEXT,
  caption           TEXT,
  source_type       TEXT        NOT NULL DEFAULT 'user',
  moderation_status TEXT        NOT NULL DEFAULT 'pending'
    CHECK (moderation_status IN ('pending','approved','flagged','rejected')),
  processing_status TEXT        NOT NULL DEFAULT 'ready'
    CHECK (processing_status IN ('local','queued','uploading','uploaded','scanning',
                                 'processing','moderating','ready','failed','rejected',
                                 'removed','expired')),
  visibility        TEXT        NOT NULL DEFAULT 'inherit',
  version           INTEGER     NOT NULL DEFAULT 1,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (storage_bucket, storage_path)
);

CREATE INDEX IF NOT EXISTS media_assets_owner_idx   ON media_assets (owner_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_assets_public_url_idx ON media_assets (public_url) WHERE public_url IS NOT NULL;

CREATE TABLE IF NOT EXISTS media_attachments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id  UUID        NOT NULL REFERENCES media_assets(id) ON DELETE CASCADE,
  entity_type     TEXT        NOT NULL,
  entity_id       UUID        NOT NULL,
  position        INTEGER     NOT NULL DEFAULT 0,
  is_cover        BOOLEAN     NOT NULL DEFAULT false,
  visibility_override TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (media_asset_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS media_attachments_entity_idx
  ON media_attachments (entity_type, entity_id, position);
CREATE INDEX IF NOT EXISTS media_attachments_cover_idx
  ON media_attachments (entity_type, entity_id) WHERE is_cover = true;

-- RLS: owner-readable; all writes go through the service role (API-mediated).
ALTER TABLE media_assets      ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_attachments ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY media_assets_owner_select ON media_assets
    FOR SELECT USING (owner_user_id = auth.uid());
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY media_attachments_owner_select ON media_attachments
    FOR SELECT USING (
      EXISTS (SELECT 1 FROM media_assets a
              WHERE a.id = media_attachments.media_asset_id
                AND a.owner_user_id = auth.uid())
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- moderation_reports: allow reporting a media asset directly (spec §45) —
-- recreate the inline CHECK with 'media' added. Constraint name is looked up
-- dynamically because it was auto-generated.
DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname
  FROM pg_constraint
  WHERE conrelid = 'moderation_reports'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%subject_type%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE moderation_reports DROP CONSTRAINT %I', cname);
  END IF;
  ALTER TABLE moderation_reports ADD CONSTRAINT moderation_reports_subject_type_check
    CHECK (subject_type IN ('user','post','comment','message','event','review','buddy_listing','media'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Feature flag (OFF): canonical dual-write + backfill stay dark until flipped.
INSERT INTO feature_flags (flag, enabled, description) VALUES
  ('media_canonical_enabled', FALSE,
   'Canonical media layer: dual-write uploads into media_assets/media_attachments and enable the backfill/read paths')
ON CONFLICT (flag) DO NOTHING;
