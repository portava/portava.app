-- Migration: content_translations — shared translation cache for posts, comments, events, trips, and bios
--
-- Uses a single sidecar table (same pattern as message_translations) so the
-- translation pipeline stays decoupled from every entity's own schema.
-- The `translated_fields` JSONB column holds a map of field_name → translated
-- string so one row covers all translatable fields of an entity.

CREATE TABLE IF NOT EXISTS content_translations (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   text        NOT NULL,  -- 'post' | 'comment' | 'event' | 'trip' | 'bio'
  entity_id     uuid        NOT NULL,  -- PK of the parent entity (profile.id for bio)
  source_language text      NOT NULL,
  target_language text      NOT NULL,
  -- JSONB map: field_name → translated string
  -- post:    { "content": "..." }
  -- comment: { "body": "..." }
  -- event:   { "title": "...", "description": "..." }
  -- trip:    { "title": "...", "trip_notes": "..." }
  -- bio:     { "bio": "..." }
  translated_fields jsonb   NOT NULL DEFAULT '{}',
  status        text        NOT NULL DEFAULT 'pending', -- 'pending' | 'translated' | 'failed'
  provider      text,
  error_message text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_translations_entity_target_ux
    UNIQUE (entity_type, entity_id, target_language)
);

CREATE INDEX IF NOT EXISTS idx_content_translations_lookup
  ON content_translations (entity_type, entity_id, target_language);

-- Add original_language to each translatable entity table.
-- These columns are set at write time (fire-and-forget language detection)
-- and consumed by the translation endpoint to decide whether to offer a
-- translation and to label it ("Translated from Spanish").

ALTER TABLE posts          ADD COLUMN IF NOT EXISTS original_language text;
ALTER TABLE posts_comments ADD COLUMN IF NOT EXISTS original_language text;
ALTER TABLE events         ADD COLUMN IF NOT EXISTS original_language text;
ALTER TABLE trips          ADD COLUMN IF NOT EXISTS original_language text;
-- Bio language is stored in a dedicated column so auto-detection never
-- overwrites the user's own language preference (profiles.default_language).
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS bio_original_language text;
