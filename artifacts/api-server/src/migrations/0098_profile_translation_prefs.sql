-- Migration 0098: profile translation preference columns (Telegraph)
-- Applied manually to Supabase on 2026-07-04.
--
-- Stores per-user messaging translation preferences.
-- Read/written by GET /api/me/translation-settings and
-- PATCH /api/me/translation-settings in messaging.ts.
--
-- Note: preferred_language (BCP-47 fallback) was added in migration 0018.
--       tag_permission was added in migration 0043.
--       This migration adds the four Telegraph-specific columns.

ALTER TABLE profiles ADD COLUMN IF NOT EXISTS preferred_message_language TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS auto_translate_messages     BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS show_original_messages      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS translation_updated_at      TIMESTAMPTZ;
